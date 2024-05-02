import async from 'async';

type EventNames = 'completed';

export class RateLimiter {
    private queue: async.QueueObject<Function>;

    constructor(private limit: number, private interval: number) {
        this.queue = async.queue((task, cb) => {
            const startTime = Date.now();
            task().then(() => {
                const remainingTime = this.interval - (Date.now() - startTime);
                setTimeout(() => cb(null), remainingTime);
            }).catch((error: any) => cb(error));
        }, this.limit);
    }

    enqueueTask<R>(task: () => Promise<R>): Promise<R> {
        return new Promise<R>((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await task();
                    this.emit('completed', result);
                    resolve(result);
                } catch (error) {
                    console.log(`enqueueTask promise error`, error);
                    reject(error);
                }
            }, (error: any) => {
                if (error) console.error(`Internal error on RateLimiter: ${error}`);
            });
        });
    }

    private eventListeners: { [event: string]: Function[] } = {};

    on(event: EventNames, listener: Function) {
        if (!this.eventListeners[event]) {
            this.eventListeners[event] = [];
        }
        this.eventListeners[event].push(listener);
    }

    off(event: EventNames, listener: Function) {
        const listeners = this.eventListeners[event];
        if (listeners) {
            const index = listeners.indexOf(listener);
            if (index >= 0) {
                listeners.splice(index, 1);
            }
        }
    }

    emit(event: EventNames, ...args: any[]) {
        const listeners = this.eventListeners[event];
        if (listeners) {
            for (const listener of listeners) {
                listener(...args);
            }
        }
    }

    getQueueLength() {
        return this.queue.length();
    }

    getRunningCount() {
        return this.queue.running();
    }
}
