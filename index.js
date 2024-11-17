const core = require('@actions/core');
const github = require('@actions/github');
const { Client } = require('pg');

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// PostgreSQL error codes that indicate concurrency issues
const RETRY_ERROR_CODES = new Set([
  '55P03', // Lock timeout
  '40P01', // Deadlock detected
  '57014'  // Statement timeout
]);

function generateSource(context, matrixInput) {
  const workflow = context.workflow;
  const job = context.job;

  let matrixParams = '';
  if (matrixInput) {
    try {
      const matrix = JSON.parse(matrixInput);
      matrixParams = Object.entries(matrix)
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join(',');
    } catch (error) {
      core.warning(`Failed to parse matrix input: ${error.message}`);
    }
  }

  return matrixParams
    ? `${workflow}/${job}(${matrixParams})`
    : `${workflow}/${job}`;
}

async function processWithRetry(params) {
  const { context, github, dbUrl, message, matrix } = params;
  const client = new Client({
    connectionString: dbUrl,
  });

  const prNumber = context.payload.pull_request.number;
  const commitSha = context.payload.pull_request.head.sha;
  const runId = context.runId;
  const runAttempt = parseInt(process.env.GITHUB_RUN_ATTEMPT, 10);
  const source = generateSource(context, matrix);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await client.connect();

      try {
        await client.query('BEGIN');

        await client.query(
          `INSERT INTO pr_comments (pr_number, commit_sha, message, created_at, source, run_id, run_attempt)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5, $6)`,
          [prNumber, commitSha, message, source, runId, runAttempt]
        );

        const { rows: comments } = await client.query(
          `WITH latest_runs AS (
            SELECT DISTINCT ON (source)
              id,
              message,
              created_at,
              source,
              run_id,
              run_attempt
            FROM pr_comments
            WHERE pr_number = $1
              AND commit_sha = $2
            ORDER BY source, run_id DESC, run_attempt DESC
          )
          SELECT * FROM latest_runs
          ORDER BY created_at ASC`,
          [prNumber, commitSha]
        );

        const combinedMessage = [
          `### Automated Workflow Results for commit ${commitSha}`,
          '',
          comments
            .map(n => {
              const timestamp = new Date(n.created_at).toISOString()
                .replace('T', ' ')
                .replace(/\.\d{3}Z$/, ' UTC');

              return [
                '<details>',
                `<summary>Message from ${timestamp} (${n.source})</summary>`,
                '',
                `Run ID: ${n.run_id}, Attempt: ${n.run_attempt}`,
                '',
                n.message,
                '</details>'
              ].join('\n');
            })
            .join('\n\n')
        ].join('\n');

        // Find existing comment for this commit
        const prComments = await github.rest.issues.listComments({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          per_page: 100
        });

        const botComment = prComments.data.find(comment =>
          comment.user.type === 'Bot' &&
          comment.body.includes('Automated Workflow Results for commit')
        );

        try {
          if (botComment) {
            await github.rest.issues.updateComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              comment_id: botComment.id,
              body: combinedMessage
            });
          } else {
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: prNumber,
              body: combinedMessage
            });
          }
        } catch (error) {
          core.error('GitHub API error:');
          core.error(`Status: ${error.status || 'unknown'}`);
          core.error(`Message: ${error.message}`);
          core.error(error.stack || error);
          throw error;
        }

        await client.query('COMMIT');
        await client.end(); // Close the connection
        return;

      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        await client.end(); // Make sure we always close the connection
      }

    } catch (error) {
      // Check if it's a GitHub API error
      if (error.status) {
        core.error('GitHub API error:');
        core.error(`Status: ${error.status}`);
        core.error(`Message: ${error.message}`);
        core.error(error.stack || error);
        throw error;
      }

      // Handle database errors
      if (RETRY_ERROR_CODES.has(error.code)) {
        const isLastAttempt = attempt === MAX_RETRIES;
        core.info(`${error.message}, ${isLastAttempt ? 'no more retries' : 'will retry'}...`);

        if (!isLastAttempt) {
          core.info(`Attempt ${attempt} failed, retrying in ${RETRY_DELAY * attempt}ms...`);
          await sleep(RETRY_DELAY * attempt);
          continue;
        }
      }

      // For all other errors, including syntax errors, fail immediately
      core.error('Database error:');
      core.error(error.stack || error);
      if (error.code) {
        core.error(`PostgreSQL Error Code: ${error.code}`);
      }
      if (error.position) {
        core.error(`Error Position: ${error.position}`);
      }
      if (error.detail) {
        core.error(`Error Detail: ${error.detail}`);
      }
      if (error.hint) {
        core.error(`Error Hint: ${error.hint}`);
      }
      throw error;
    }
  }

  // If we get here, all retries failed
  throw new Error(`Failed after ${MAX_RETRIES} attempts`);
}

async function run() {
  try {
    const message = core.getInput('message', { required: true });
    const dbUrl = core.getInput('neon-db-url', { required: true });
    const token = core.getInput('github-token', { required: true });
    const matrix = core.getInput('matrix');

    const octokit = github.getOctokit(token);

    await processWithRetry({
      context: github.context,
      github: octokit,
      dbUrl,
      message,
      matrix
    });
  } catch (error) {
    core.error('Action failed:');
    core.error(error.stack || error);
    core.setFailed(error.message);
  }
}

run();
