import instantiate from '../try/instantiate'
import request from 'superagent-promise';
import slugid from 'slugid';
import taskcluster from 'taskcluster-client';
import fs from 'mz/fs';
import fsPath from 'path';
import mustache from 'mustache';
import * as projectConfig from '../project_scopes';
import assert from 'assert';
import retry from 'promise-retries';

import Path from 'path';
import Base from './base';
import URL from 'url';

const GRAPH_RETIRES = 2;
const GRAPH_INTERVAL = 5000;
const GRAPH_REQ_TIMEOUT = 30000;
const TRY_PREFIX = 'try:';

/**
Parses given url into path and host parts.


  parseUrl('https://hg.mozilla.org/try/');
  // => { host: 'https://hg.mozilla.org', path: '/try' }

*/
function parseUrl(url) {
  let parsed = URL.parse(url);
  let path = Path.resolve(parsed.path);

  path = (path === '/') ? '' : path;

  return {
    path,
    host: `${parsed.protocol || 'http'}//${parsed.host}`
  };
}

/**
Fetch a task graph from a url (retires included...)
*/
async function fetchGraph(job, url) {
  assert(url, 'url is required');
  console.log(`fetching graph ${url}`);
  let opts = { interval: GRAPH_INTERVAL, retires: GRAPH_RETIRES };
  try {
    return await retry(opts, async () => {
      let res = await request.get(url).
        timeout(GRAPH_REQ_TIMEOUT).
        buffer(true).
        end();

      if (res.error) throw res.error;
      return res.text;
    });
  } catch (e) {
    throw new Error(`Could not fetch graph at ${url}\n ${e.stack}`);
  }
}

/**
Parse out a try flag in the commit message.
*/
function parseCommitMessage(message) {
  let tryIdx = message.indexOf(TRY_PREFIX);

  // No try...
  if (tryIdx === -1) return null;

  // End of try details are first newline or end of string...
  let endIdx = message.indexOf('\n', tryIdx);
  endIdx = (endIdx === -1) ? message.length : endIdx;

  let msg = message.slice(tryIdx, endIdx);
  return msg;
}

export default class TaskclusterGraphJob extends Base {
  async work(job) {
    let { revision_hash, pushref, repo } = job.data;
    let push = await this.runtime.pushlog.getOne(repo.url, pushref.id);
    let lastChangeset = push.changesets[push.changesets.length - 1];

    let repositoryUrlParts = parseUrl(repo.url);
    let urlVariables = {
      // These values are defined in projects.yml
      alias: repo.alias,
      revision: lastChangeset.node,
      path: repositoryUrlParts.path,
      host: repositoryUrlParts.host
    };

    // Try fetching from .taskgraph.yml, the preferred location, falling back
    // to the project URL The latter is supported only for branches to which
    // .taskcluster.yml (and the task-graph generation support in taskcluster/
    // to which it points) has not yet been merged.
    let graphUrl, graphText;
    try {
      graphUrl = projectConfig.tcYamlUrl(this.config.try, urlVariables);
      console.log(`Fetching '.taskcluster.yml' url ${graphUrl} for '${repo.alias}' push id ${push.id}`);
      graphText = await fetchGraph(job, graphUrl);
    } catch (err) {
      graphUrl = projectConfig.url(this.config.try, repo.alias, urlVariables);
      console.log(`Fetching url ${graphUrl} for '${repo.alias}' push id ${push.id}`);
      graphText = await fetchGraph(job, graphUrl);
    }

    let variables = {
      owner: push.user,
      source: graphUrl,
      revision: lastChangeset.node,
      project: repo.alias,
      level: projectConfig.level(this.config.try, repo.alias),
      revision_hash,
      // Intention use of ' ' must be a non zero length string...
      comment: parseCommitMessage(lastChangeset.desc) || ' ',
      pushlog_id: String(push.id),
      url: repo.url,
      importScopes: true
    };

    let graph;
    try {
      graph = instantiate(graphText, variables);
    } catch (e) {
      console.log("Error creating graph due to yaml syntax errors...", e);
      // Even though we won't end up doing anything overly useful we still need
      // to convey some status to the end user ... The instantiate error should
      // be safe to pass as it is simply some yaml error.
      let errorGraphUrl =
        mustache.render(this.config.try.errorTaskUrl, urlVariables);
      let errorGraph = await fetchGraph(job, errorGraphUrl);
      graph = instantiate(errorGraph, variables);
      graph.tasks[0].task.payload.env = graph.tasks[0].task.payload.env || {};
      graph.tasks[0].task.payload.env.ERROR_MSG = e.toString()
    }

    let id = slugid.nice();
    let scopes = projectConfig.scopes(this.config.try, repo.alias);

    // strip `version`; this is temporary while we are still using the task-graph scheduler
    delete graph.version;

    let scheduler = new taskcluster.Scheduler({
      credentials: this.config.taskcluster.credentials,
      // Include scopes for creating and extending task graphs.
      authorizedScopes: scopes.concat(['scheduler:create-task-graph', 'scheduler:extend-task-graph:*'])
    });

    // Assign maximum level of scopes to the graph....
    graph.scopes = scopes;

    // Add the scope to extend the task graph to all decision tasks within the graph.
    // Currently some decision tasks might not contain this scope.  This is a temporary
    // solution until those decision tasks are migrated over to use the big-graph
    // scheduler, at which point this scope is moot.
    for (let taskInfo of graph.tasks) {
      let task = taskInfo.task;
      task.scopes = task.scopes || [];
      if (!task.scopes.includes('scheduler:extend-task-graph:*')) {
        // Log a message when this happens so these tasks can be tracked down
        // and fixed
        console.log(
          `Decision Task does not contain scopes necessary for extending ` +
          `task graph. Adding extend-task-graph scope. Task ID: ${taskInfo.taskId}`
        );
        task.scopes = task.scopes.concat(['scheduler:extend-task-graph:*']);
      }
    }

    // On the assumption that the only task in the graph is a decision task, give it the
    // scopes afforded to the whole graph, too.
    for (let taskInfo of graph.tasks) {
      let task = taskInfo.task;
      for (let scope of scopes) {
        if (!task.scopes.includes(scope)) {
          task.scopes.push(scope);
        }
      }
    }

    console.log(
        `Posting job for project '${repo.alias}' with id ${id} ` +
        `and scopes ${graph.scopes.join(', ')}`
    );
    try {
      await scheduler.createTaskGraph(id, graph);
    } catch (e) {
      console.log(`Error posting job for '${repo.alias}', ${JSON.stringify(e, null, 2)}`);
      throw e;
    }
  }
}
