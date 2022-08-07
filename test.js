require('dotenv').config();

const nodejieba = require('nodejieba');
const mongoDB = require('mongodb');
const { exit } = require('process');

nodejieba.load({ dict: './dict.txt' });

const weight_dict = {};
const freeq_dict = {};

nodejieba.insertWord('黃金泡菜');
nodejieba.insertWord('黃金里肌');
nodejieba.insertWord('黃金豬肉');
nodejieba.insertWord('吸球');
nodejieba.insertWord('6人房');
nodejieba.insertWord('2人房');

(async () => {
    const client = new mongoDB.MongoClient(process.env.DB_CONN_STRING);
    await client.connect();

    const col = client.db().collection('messages');

    const messages = await col.find({ channel: 'C1FNKQ1KM' }).toArray();

    messages.filter((v) => {
        return parseFloat(v.ts) * 1000 > new Date('2022-05-01').getTime();
    }).forEach((v) => {
        if (v.text) {
            const weights = nodejieba.extract(v.text, 5);
            const w_dict = Object.fromEntries(weights.map((v) => {
                return [v.word, v.weight];
            }))

            const tags = nodejieba.tag(v.text);
            const tags_dict = Object.fromEntries(tags.map((v) => [v.word, v.tag]));

            const result = nodejieba.cutHMM(v.text);

            const times_dict = result.reduce((prev, curr) => {
                return {
                    ...prev,
                    [curr]: typeof prev[curr] === 'number' ? prev[curr] + 1 : 1,
                }
            }, {});

            Object.entries(times_dict).forEach(([word, times]) => {
                if (!['N', 'Vi'].includes(tags_dict[word])) return;
                if (typeof w_dict[word] !== 'number') return;

                if (typeof weight_dict[word] !== 'number') {
                    weight_dict[word] = 0;
                }
                weight_dict[word] += w_dict[word];

                if (typeof freeq_dict[word] !== 'number') {
                    freeq_dict[word] = 0;
                }
                freeq_dict[word] += times;
            });
        }
    });

    const sorted = Object.keys(weight_dict).filter((v) => (/[\u3400-\u9FBF]/.test(v))).filter((v) => freeq_dict[v] > 10).sort((a, b) => {
        const an = freeq_dict[a];
        const bn = freeq_dict[b];

        return bn - an;
    });

    sorted.slice(0, 100).forEach((v) => {
        console.log(v, freeq_dict[v]);
    });

    exit();
})();