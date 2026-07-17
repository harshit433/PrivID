/**
 * BullMQ processor registry. Each job file exports a `{ name, process, concurrency? }`
 * descriptor; they are bound here to Workers on the shared bull connection.
 */
import { Worker, type Processor } from 'bullmq';
import { getBullConnection, logger, type QueueName, type JobMap } from '@trustroute/core';
import { ringTimeout } from './jobs/ringTimeout';
import { trustRecompute } from './jobs/trustRecompute';
import { shadowRecompute } from './jobs/shadowRecompute';
import { massOutreach } from './jobs/massOutreach';
import { connectionExpiry } from './jobs/connectionExpiry';
import { channelExpiry } from './jobs/channelExpiry';
import { statusExpiry } from './jobs/statusExpiry';
import { tokenRotation } from './jobs/tokenRotation';
import { referralQualification } from './jobs/referralQualification';
import { handlePropagation } from './jobs/handlePropagation';
import { dataExport } from './jobs/dataExport';
import { businessMessageDeliver } from './jobs/businessMessageDeliver';
import { mlFeedback } from './jobs/mlFeedback';

export interface JobDescriptor<N extends QueueName> {
  name: N;
  process: Processor<JobMap[N]>;
  concurrency?: number;
}

const descriptors: Array<JobDescriptor<QueueName>> = [
  ringTimeout, // P4
  // P8
  trustRecompute,
  shadowRecompute,
  massOutreach,
  connectionExpiry,
  channelExpiry,
  statusExpiry,
  tokenRotation,
  referralQualification,
  handlePropagation,
  dataExport,
  businessMessageDeliver,
  mlFeedback,
] as Array<JobDescriptor<QueueName>>;

export function startWorkers(): Worker[] {
  return descriptors.map((d) => {
    const w = new Worker(d.name, d.process, {
      connection: getBullConnection(),
      concurrency: d.concurrency ?? 5,
    });
    w.on('failed', (job, err) => logger.error('worker', `job ${d.name} failed`, { jobId: job?.id, error: err.message }));
    return w;
  });
}
