
const Queue = require('bull');
const queue = new Queue('queue', {
    limiter: {
        max: 1,
        duration: 5000,
    }
});
queue.isReady().then(() => {
    console.log('queue is ready');

    queue.process((job, done) => {
        setTimeout(() => {
            console.log('data', job.data.number);
            done(null, job.data.number);
        }, 1000);
    });

    const data = [0, 1, 2, 3, 4];

    const onFinish = (v) => {
        if (v % 10 < 9) {
            queue.add({
                number: v + 1,
            }).then((j) => {
                console.log(`job ${j.id} added.`);

                return j.finished();
            }).then(onFinish);
        }
    }

    queue.addBulk(data.map((v) => ({
        data: {
            number: v * 10,
        },
    }))).then((jobs) => {
        jobs.forEach((j) => {
            console.log(`job ${j.id} added.`);

            j.finished().then(onFinish);
        });
    });
});
