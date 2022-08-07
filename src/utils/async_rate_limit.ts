import { AsyncBooleanResultCallback, AsyncFunctionEx, doWhilst, eachLimit, IterableCollection, AsyncIterator } from "async";

export async function doWhilstWithRate<T, R, E = Error>(
    fn: AsyncFunctionEx<T, E>,
    test: (cb: AsyncBooleanResultCallback) => void,
    rateLimit: number
): Promise<R> {
    let lastTime: number | null = null;

    return doWhilst<T, R, E>(
        (cb) => {
            const timeoutSec = lastTime ? rateLimit - (Date.now() - lastTime) : 0;
            setTimeout(() => {
                lastTime = Date.now();
                fn(cb);
            }, timeoutSec);
        },
        (cb) => test(cb),
    );
}

export async function eachLimitWithRate<T, E extends Error = Error>(arr: IterableCollection<T>, limit: number, iterator: AsyncIterator<T, E>, rateLimit: number): Promise<void> {
    let lastTime: number | null = null;

    return eachLimit(arr, limit, (item, cb) => {
        const timeoutSec = lastTime ? rateLimit - (Date.now() - lastTime) : 0;
        setTimeout(() => {
            lastTime = Date.now();
            iterator(item, cb);
        }, timeoutSec);
    });
}
