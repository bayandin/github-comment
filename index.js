const core = require('@actions/core');
const github = require('@actions/github');
const { neon } = require('@neondatabase/serverless');

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second
const LOCK_TIMEOUT = 10000; // 10 seconds
const STATEMENT_TIMEOUT = 5000; // 5 seconds

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processWithRetry(params, attempt = 1) {
  const { context, github, dbUrl, message } = params;
  const sql = neon(dbUrl);
  const prNumber = context.payload.pull_request.number;

  try {
    await sql.transaction(async (tx) => {
      // Set transaction-level timeouts
      await tx`SET lock_timeout = ${LOCK_TIMEOUT}`;
      await tx`SET statement_timeout = ${STATEMENT_TIMEOUT}`;

      // Try to acquire lock with timeout
      await tx`
        SELECT 1
        FROM pr_comments
        WHERE pr_number = ${prNumber}
        FOR UPDATE NOWAIT
      `;

      // Save new message
      await tx`
        INSERT INTO pr_comments (pr_number, message, created_at)
        VALUES (${prNumber}, ${message}, NOW())
      `;

      // Get ALL messages with a timeout
      const comments = await tx`
        SELECT message, id, created_at
        FROM pr_comments
        WHERE pr_number = ${prNumber}
        ORDER BY created_at ASC
      `;

      const combinedMessage = comments
        .map(n => {
          const timestamp = new Date(n.created_at).toISOString()
            .replace('T', ' ')
            .replace(/\.\d{3}Z$/, ' UTC');

          return [
            '<details>',
            `<summary>Message from ${timestamp}</summary>`,
            '',
            n.message,
            '</details>'
          ].join('\n');
        })
        .join('\n\n');

      // Find existing comment
      const prComments = await github.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        per_page: 100
      });

      const botComment = prComments.data.find(comment =>
        comment.user.type === 'Bot' &&
        comment.body.includes('Automated Workflow Results')
      );

      const commentBody = `### Automated Workflow Results\n\n${combinedMessage}`;

      try {
        if (botComment) {
          await github.rest.issues.updateComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            comment_id: botComment.id,
            body: commentBody
          });
        } else {
          await github.rest.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: prNumber,
            body: commentBody
          });
        }
      } catch (error) {
        console.error('GitHub API error:', error);
        throw error;
      }
    }, {
      isolationLevel: 'serializable',
      timeout: LOCK_TIMEOUT
    });
  } catch (error) {
    if (error.code === '55P03') {
      console.log('Lock timeout, will retry...');
    } else if (error.code === '40P01') {
      console.log('Deadlock detected, will retry...');
    } else if (error.code === '57014') {
      console.log('Statement timeout, will retry...');
    }

    if (attempt < MAX_RETRIES) {
      console.log(`Attempt ${attempt} failed, retrying...`);
      await sleep(RETRY_DELAY * attempt);
      return processWithRetry(params, attempt + 1);
    }
    throw error;
  }
}

async function run() {
  try {
    const message = core.getInput('message', { required: true });
    const dbUrl = core.getInput('neon-db-url', { required: true });
    const token = core.getInput('github-token', { required: true });

    const octokit = github.getOctokit(token);

    await processWithRetry({
      context: github.context,
      github: octokit,
      dbUrl,
      message
    });
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
