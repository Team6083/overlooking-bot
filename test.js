require('dotenv').config();

const nodejieba = require('nodejieba');
const mongoDB = require('mongodb');
const { exit } = require('process');
const { writeFileSync } = require('fs');

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

    // C1FNKQ1KM, CC2LH7T1N, GHNUH43J6
    const messages = await col.find({ channel: 'C1FNKQ1KM' }).toArray();

    messages
        .filter((v) => !['channel_join', 'channel_topic', 'bot_add', 'bot_remove', 'bot_message'].includes(v.subtype))
        .filter((v) => {
            return parseFloat(v.ts) * 1000 > new Date('2022-05-01').getTime();
        })
        .forEach((v) => {
            if (v.text) {
                const text = v.text
                    .replace("@channel", "")
                    .replace(/\<\!channel\>/, "")
                    .replace(/\<\@[A-Z0-9]*\>/, "")
                    .replace(/\:[^\:]*\:/, "");

                const weights = nodejieba.extract(text, 10);
                const w_dict = Object.fromEntries(weights.map((v) => {
                    return [v.word, v.weight];
                }))

                const tags = nodejieba.tag(text);
                const tags_dict = Object.fromEntries(tags.map((v) => [v.word, v.tag]));

                const result = nodejieba.cutHMM(text);

                const times_dict = result.reduce((prev, curr) => {
                    return {
                        ...prev,
                        [curr]: typeof prev[curr] === 'number' ? prev[curr] + 1 : 1,
                    }
                }, {});

                // ignore messages that only have one
                // if (Object.keys(times_dict).length < 2) return;

                Object.entries(times_dict).forEach(([word, times]) => {
                    // if (!['N', 'Vi'].includes(tags_dict[word])) return;
                    if (['r'].includes(tags_dict[word])) return;

                    // remove words that's not in extract
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

    const sorted = Object.keys(weight_dict).sort((a, b) => {
        const an = freeq_dict[a];
        const bn = freeq_dict[b];

        return bn - an;
    });

    let str = '';
    sorted.forEach((v, i) => {
        const num = freeq_dict[v];
        str += `${num}\t${v}\n`;

        if (i < 20) console.log(v, num);
    });

    writeFileSync('./word_cloud.txt', str);

    exit();
})();