import { Queue } from 'bullmq';
import Redis from 'ioredis';

let queue: Queue | null = null;

function getBullRedis(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export interface BusinessMessageDeliverJob {
  message_id: string;
}

export function getBusinessMessageQueue(): Queue<BusinessMessageDeliverJob> {
  if (!queue) {
    queue = new Queue<BusinessMessageDeliverJob>('business-message-deliver', {
      connection: getBullRedis(),
    });
  }
  return queue;
}

export async function enqueueBusinessMessageDelivery(messageId: string): Promise<void> {
  const q = getBusinessMessageQueue();
  await q.add(
    'deliver',
    { message_id: messageId },
    {
      jobId: `biz-msg-${messageId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
