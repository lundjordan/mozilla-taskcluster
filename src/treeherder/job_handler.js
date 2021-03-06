import _ from 'lodash';
import slugid from 'slugid';
import { Queue, QueueEvents, Scheduler } from 'taskcluster-client';
import Project from 'mozilla-treeherder/project';
import Debug from 'debug';
import parseRoute from '../util/route_parser';

let Joi = require('joi');
let debug = Debug('treeherder:job_handler');

let events = new QueueEvents();

// XXX: Consider making this a configuration options?
const TREEHERDER_INTERVAL = 1000;

// Schema for the task.extra.treeherder field.
const SCHEMA = Joi.object().keys({
  // Maps directly to `build_platform`
  build: Joi.object().keys({
    platform: Joi.string().required().
      description('Treeherder platform name'),
    os_name: Joi.string().default('-').
      description('Operating system name for build (linux)'),
    architecture: Joi.string().default('-').
      description('Operating system architecture (x64, etc..)')
  }).required().rename('os', 'os_name'),

  machine: Joi.object().keys({
    platform: Joi.string().required(),
    os_name: Joi.string().default('-'),
    architecture: Joi.string().default('-')
  }).required().rename('os', 'os_name'),

  machineId: Joi.string().
    description('Machine ID that executed the task run'),

  symbol: Joi.string().required().
    description('Treeherder job symbol'),
  groupName: Joi.string().
    description('Treeherder group name (seen when hovering over group symbol)').
    default('unknown'),
  groupSymbol: Joi.string().
    description('Treeherder group symbol').
    // If the default is not set to ? 'unknown' is used in the UI which will
    // trigger that to be displayed when ? is used no extra UI is present.
    default('?'),
  tier: Joi.number().
    description('Treeherder tier').
    default(1),
  productName: Joi.string().
    description('TODO: Figure out what this is for'),

  collection: Joi.object().unknown(true).keys({
    opt: Joi.boolean(),
    debug: Joi.boolean(),
    pgo: Joi.boolean(),
    cc: Joi.boolean(),
    asan: Joi.boolean(),
    tsan: Joi.boolean(),
    addon: Joi.boolean(),
  }),

  revision_hash: Joi.string().allow('').
    description('Calculated revision hash when result set was created'),

  revision: Joi.string().allow('').
    description('Top level revision for the push'),

  jobKind: Joi.string().allow('').
    description('Kind of job (build, test, other)')
});

const EVENT_MAP = {
  [events.taskPending().exchange]: 'pending',
  [events.taskRunning().exchange]: 'running',
  [events.taskCompleted().exchange]: 'completed',
  [events.taskFailed().exchange]: 'failed',
  [events.taskException().exchange]: 'exception'
};

function defer() {
  let accept;
  let reject;
  let promise = new Promise((_accept, _reject) => {
    accept = _accept;
    reject = _reject;
  });

  promise.accept = accept;
  promise.reject = reject;
  return promise;
}

/** Convert Date object or JSON date-time string to UNIX timestamp */
function timestamp(date) {
  return Math.floor(new Date(date).getTime() / 1000);
};

function inspectorLink(taskId, run) {
  return `https://tools.taskcluster.net/task-inspector/#${taskId}/${run.runId}`;
}

function stateFromRun(run) {
  switch (run.state) {
    case 'exception':
    case 'failed':
      return 'completed';
    default:
      return run.state;
  }
}

function resultFromRun(run) {
  switch (run.state) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'testfailed';
    case 'exception':
      if (run.reasonResolved === 'canceled') {
        return 'usercancel'
      }
      
      return 'exception';
    default:
      return 'unknown';
  }
}

function createLogReferences(queue, taskId, run) {
  let logUrl = queue.buildUrl(
    queue.getArtifact, taskId, run.runId, 'public/logs/live_backing.log'
  );

  return [{
    // XXX: This is a magical name see 1147958 which enables the log viewer.
    name: 'builds-4h',
    url: logUrl
  }];
}

export function jobFromTask(taskId, task, run) {
  // Create the default set of options...
  let treeherder = (task.extra && task.extra.treeherder) || {};
  treeherder = _.merge(
    {
      build: {
        platform: task.workerType
      },
      machine: {
        platform: task.workerType
      },
      machineId: run.workerId,
      revision_hash: "",
      revision: ""
    },
    treeherder
  );

  // Here primarily for backwards compatibility so we don't need to require
  // tasks to define collection
  if (!treeherder.collection) {
    treeherder.collection = { opt: true };
  }

  // Chunks are often numbers type cast here so we don't need to enforce
  // this everywhere...
  if (typeof treeherder.symbol === 'number') {
    treeherder.symbol = String(treeherder.symbol);
  }

  // Validation is useful primarily for use with kue viewer as you can easily
  // see what failed during the validation.
  let validate = Joi.validate(treeherder, SCHEMA);
  if (validate.error) {
    throw new Error(validate.error.annotate());
  }

  let config = validate.value;
  let job = {
    job_guid: `${slugid.decode(taskId)}/${run.runId}`,
    build_system_type: 'taskcluster',
    build_platform: config.build,
    machine_platform: config.machine,
    machine: config.machineId,
    // Maximum job name length is 100 chars...
    name: task.metadata.name.slice(0, 99),
    reason: 'scheduled',  // use reasonCreated or reasonResolved
    job_symbol: config.symbol,
    submit_timestamp: timestamp(task.created),
    start_timestamp: (run.started ? timestamp(run.started) : undefined),
    end_timestamp: (run.resolved ? timestamp(run.resolved) : undefined),
    who: task.metadata.owner,
    option_collection: config.collection
  };

  // Optional configuration details if these keys are present it has an effect
  // on the job results so they are conditionally added to the object.
  if (config.groupName) job.group_name = config.groupName;
  if (config.groupSymbol) job.group_symbol = config.groupSymbol;
  if (config.productName) job.product_name = config.productName;
  if (config.tier) job.tier = config.tier;

  // Add link to task-inspector
  let inspectorLink = 'https://tools.taskcluster.net/task-inspector/#' +
                      taskId + '/' + run.runId;

  // TODO: Consider removing this in favor of something else...
  job.artifacts = [{
    type:     'json',
    name:     'Job Info',
    blob: {
      job_details: [{
        url:            inspectorLink,
        value:          'Inspect Task',
        content_type:   'link',
        title:          'Inspect Task'
      }]
    }
  }];

  return job;
}

class Handler {
  constructor(config, listener) {
    this.config = config;
    this.queue = new Queue();
    this.scheduler = new Scheduler();

    this.prefix = config.treeherderTaskcluster.routePrefix;
    this.listener = listener;

    // Treeherder project instances used for posting job details to treeherder
    this.projects = {}

    listener.on('message', (message) => {
      return this.handleTaskEvent(message);
    });

    // Pending pushes per repository...
    this._pendingPushes = {
      /**
      example: {
        active: false,
        promise: Promise,
        pushes: []
      }
      */
    };
  }

  addPush(push) {
    let project = push.project;

    // Create the state for the pending push if we don't have one yet...
    if (!this._pendingPushes[project]) {
      this._pendingPushes[project] = {
        promise: defer(),
        pushes: [],
        active: false
      };
    }

    // Note: the logic here is somewhat complicated and involves mutating
    // "global" state it is intended that you use add push to return a promise
    // and ignore most of these details (and these are all stored in a small
    // number of locations)

    let pending = this._pendingPushes[project];
    pending.pushes.push(push);
    return pending.promise;
  }

  async tryPush(projectName, pending) {
    // Extract the mutable state for this push no matter what we are done with
    // this data and it must be reset to allow for any ongoing pushes to add
    // their pending data.
    let { pushes, promise } = pending;

    // Update state here so pending operations can continue to add data even
    // while we are running pushes...
    pending.active = true;
    pending.promise = defer();
    pending.pushes = [];

    try {
      debug('running push', { projectName, count: pushes.length })
      let project  = this.projects[projectName];
      let res = await project.postJobs(pushes);
      // Ensure active is false so we can push again...
      // // Ensure active is false so we can push again...
      promise.accept(res);
      pending.active = false;
    } catch (err) {
      debug('failed push to treeherder', err.stack);
      promise.reject(err);
      pending.active = false;
    }
  }

  async check() {
    // Pending push operations...
    let ops = [];

    for (let projectName of Object.keys(this._pendingPushes)) {
      debug('run check for', { projectName });
      let pending = this._pendingPushes[projectName];
      if (!pending.active && pending.pushes.length) {
        debug('attempting push for', { projectName })
        ops.push(this.tryPush(projectName, pending));
        continue;
      }
      debug('skip push', { projectName, active: pending.active });
    }
    return await Promise.all(ops);
  }

  start() {
    this._interval = setInterval(() => {
      this.check().catch((e) => {
        console.error('Error while attempting to push to treeherder', e.stack);
      });
    }, TREEHERDER_INTERVAL);
  }

  async handleTaskRerun(pushInfo, task, payload) {
    let taskId = payload.status.taskId;
    let run = payload.status.runs[payload.runId - 1];

    await this.addPush({
      revision_hash: pushInfo.revisionHash,
      revision: pushInfo.revision,
      project: pushInfo.project,
      job: Object.assign(
        jobFromTask(taskId, task, run),
        {
          state: 'completed',
          result: 'retry',
          log_references: createLogReferences(this.queue, taskId, run)
        }
      )
    });
  }

  /**
  Post pending results to treeherder this method also handles the edge case of
  marking previous runs of the task as "retries" if in a task graph with
  remaining retries.

  @param {Object} pushInfo created from the parsed task route.
  @param {Object} task definition.
  @param {Object} payload from event.
  */
  async handleTaskPending(pushInfo, task, payload) {
    let taskId = payload.status.taskId;
    let run = payload.status.runs[payload.runId];

    // Specialized handling for reruns...
    if (
      // This only can be run when the runId is present and > 0
      payload.runId &&
      // Only issue this if the run was created for a rerun
      (run.reasonCreated === 'rerun' || run.reasonCreated === 'retry')
    ) {
      await this.handleTaskRerun(pushInfo, task, payload);
    }

    await this.addPush({
      revision_hash: pushInfo.revisionHash,
      revision: pushInfo.revision,
      project: pushInfo.project,
      job: Object.assign(
        jobFromTask(taskId, task, run),
        {
          state: stateFromRun(run),
          result: resultFromRun(run)
        }
      )
    });
  }

  shouldReportExceptionRun(run) {
    return run.reasonCreated !== 'exception';
  }

  async handleTaskRunning(pushInfo, task, payload) {
    let taskId = payload.status.taskId;
    let run = payload.status.runs[payload.runId];

    await this.addPush({
      revision_hash: pushInfo.revisionHash,
      revision: pushInfo.revision,
      project: pushInfo.project,
      job: Object.assign(
        jobFromTask(taskId, task, run),
        {
          state: stateFromRun(run),
          result: resultFromRun(run)
        }
      )
    });
  }

  async handleTaskException(pushInfo, task, payload) {
    let taskId = payload.status.taskId;
    let run = payload.status.runs[payload.runId];

    if (!this.shouldReportExceptionRun(run)) {
      debug('ignoring task exception for task %s. Reason Resolved: %s',
             taskId,
             run.reasonResolved
      );
      return;
    }

    await this.addPush({
      revision_hash: pushInfo.revisionHash,
      revision: pushInfo.revision,
      project: pushInfo.project,
      job: Object.assign(
        jobFromTask(taskId, task, run),
        {
          state: stateFromRun(run),
          result: resultFromRun(run)
        }
      )
    });
  }

  async handleTaskFailed(pushInfo, task, payload) {
    let taskId = payload.status.taskId;
    let run = payload.status.runs[payload.runId];

    let state = stateFromRun(run);
    let result = resultFromRun(run);

    // To correctly handle the rerun case we must not mark jobs which will be
    // marked as retry as 'completed' this means we must determine if this run
    // will trigger a retry by querying the scheduler.
    if (
      task.schedulerId === 'task-graph-scheduler' &&
      task.taskGroupId
    ) {
      try {
        let taskInfo = await this.scheduler.inspectTask(task.taskGroupId, taskId);
        if (taskInfo.reruns > payload.runId) {
          // Simply allow the rerun handle to update the task...
          return;
        }
      } catch(e) {
        debug(
          `Could not retrieve task graph information for ${task.taskGroupId}, ` +
          `assuming task is part of a task group not scheduled through task-graph-scheduler.`
        );
      }
    }

    await this.addPush({
      revision_hash: pushInfo.revisionHash,
      revision: pushInfo.revision,
      project: pushInfo.project,
      job: Object.assign(
        jobFromTask(taskId, task, run),
        {
          state,
          result,
          log_references: createLogReferences(this.queue, taskId, run)
        }
      )
    });
  }

  async handleTaskCompleted(pushInfo, task, payload) {
    let taskId = payload.status.taskId;
    let run = payload.status.runs[payload.runId];

    await this.addPush({
      revision_hash: pushInfo.revisionHash,
      revision: pushInfo.revision,
      project: pushInfo.project,
      job: Object.assign(
        jobFromTask(taskId, task, run),
        {
          state: stateFromRun(run),
          result: resultFromRun(run),
          log_references: createLogReferences(this.queue, taskId, run)
        }
      )
    });
  }

  /**
   * Create (or return an existing) treeherder project instance for a given
   * project.
   *
   * @param {String} projectName - Name of the treeherder project
   *
   * @return {Object} Treeherder project instance
   */
  getProject(projectName) {
    if (!this.projects[projectName]) {
      this.projects[projectName] = new Project(projectName, {
          clientId: this.config.treeherder.credentials.clientId,
          secret: this.config.treeherder.credentials.secret,
          baseUrl: this.config.treeherder.apiUrl,
          // Issue up to 2 retries for 429 throttle issues.
          throttleRetries: 2
      });
    }

    return this.projects[projectName];
  }

  /**
  Handle an incoming task event and convert it into a pending job push for
  treeherder...
  */
  async handleTaskEvent(message) {
    let { payload, exchange, routes } = message;

    if (!EVENT_MAP[exchange]) {
      console.error('Unknown state', exchange);
      return;
    }

    let route = routes.find((route) => {
      return route.split('.')[0] === this.prefix;
    });

    if (!route) {
      throw new Error(`Unexpected message (no route) on ${exchange}`);
    }

    let parsedRoute = parseRoute(route);

    if (!parsedRoute.project) {
      debug(
          `Error: Could not determine project name for ${taskId}. Task routes: ${routes}. ` +
          `Parsed route info: ${JSON.stringify(parsedRoute)}`
      );
      return;
    }

    let treeherderProject = this.getProject(parsedRoute.project);
    let task = await this.queue.task(payload.status.taskId);

    // During a transition period, some tasks might contain a revision within
    // the task definition that should override the revision in the routing key.
    let revision = _.get(task, 'extra.treeherder.revision');

    if (revision) {
      parsedRoute.revision = revision;
    }

    if (!parsedRoute.revision && !parsedRoute.revisionHash) {
      debug(
        `Error: Skip submitting job info for ${taskId}.  Missing revision and revision_hash ` +
        `information. Task routes: ${routes}. Parsed route info: ${JSON.stringify(parsedRoute)}`
      );
      return;
    }

    switch (EVENT_MAP[exchange]) {
      case 'pending':
        return this.handleTaskPending(
          parsedRoute, task, payload
        );
      case 'running':
        return await this.handleTaskRunning(
          parsedRoute, task, payload
        );
      case 'completed':
        return await this.handleTaskCompleted(
          parsedRoute, task, payload
        );
      case 'exception':
        return await this.handleTaskException(
          parsedRoute, task, payload
        );
      case 'failed':
        return this.handleTaskFailed(
          parsedRoute, task, payload
        );
    }
  }
}

export default async function(config, listener) {
  let instance = new Handler(config, listener);
  instance.start();
  await listener.resume();
}
