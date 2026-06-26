import * as mongoDB from 'mongodb';

export interface DbCollections {
    messages: mongoDB.Collection;
    changedMessages: mongoDB.Collection;
    deletedMessages: mongoDB.Collection;
    driveComplianceJobs: mongoDB.Collection;
    settings: mongoDB.Collection;
}

export async function connectDb(connString: string): Promise<{ client: mongoDB.MongoClient; collections: DbCollections }> {
    const client = new mongoDB.MongoClient(connString);
    await client.connect();
    const db = client.db();
    return {
        client,
        collections: {
            messages: db.collection('messages'),
            changedMessages: db.collection('changedMessages'),
            deletedMessages: db.collection('deletedMessages'),
            driveComplianceJobs: db.collection('driveComplianceJobs'),
            settings: db.collection('settings'),
        },
    };
}
