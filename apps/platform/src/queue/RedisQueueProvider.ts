import { Queue as BullQueue, Worker } from 'bullmq'
import { logger } from '../config/logger'
import { batch } from '../utilities'
import Job, { EncodedJob } from './Job'
import Queue, { QueueTypeConfig } from './Queue'
import QueueProvider from './QueueProvider'

export interface RedisConfig extends QueueTypeConfig {
    driver: 'redis'
    host: string
    port: number
}

export default class RedisQueueProvider implements QueueProvider {

    config: RedisConfig
    queue: Queue
    bull: BullQueue
    worker?: Worker
    batchSize = 50 as const

    constructor(config: RedisConfig, queue: Queue) {
        this.queue = queue
        this.config = config
        this.bull = new BullQueue('parcelvoy', {
            connection: config,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'exponential',
                    delay: 1000,
                },
            },
        })
    }

    async enqueue(job: Job): Promise<void> {
        try {
            const { name, data, opts } = this.adaptJob(job)
            await this.bull.add(name, data, opts)
        } catch (error) {
            logger.error(error, 'redis:error:enqueue')
        }
    }

    async enqueueBatch(jobs: Job[]): Promise<void> {
        for (const part of batch(jobs, this.batchSize)) {
            await this.bull.addBulk(part.map(item => this.adaptJob(item)))
        }
    }

    private adaptJob(job: Job) {
        return {
            name: job.name,
            data: job,
            opts: {
                removeOnComplete: true,
                removeOnFail: {
                    count: 50,
                    age: 24 * 3600, // keep up to 24 hours
                },
                delay: job.options.delay,
                attempts: job.options.attempts,
            },
        }
    }

    start(): void {
        this.worker = new Worker('parcelvoy', async job => {
            await this.queue.dequeue(job.data)
        }, {
            connection: this.config,
            concurrency: this.batchSize,
        })

        this.worker.on('failed', (job, error) => {
            this.queue.errored(job?.data as EncodedJob, error)
            logger.error({ error }, 'redis:error:processing')
        })
    }

    close(): void {
        this.bull.close()
        this.worker?.close()
    }
}
