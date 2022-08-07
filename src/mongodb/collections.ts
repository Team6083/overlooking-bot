import { Db } from 'mongodb';

export function getMessageCollection(db: Db) {
    return db.collection('messages');
}

export function getChangedMsgCollection(db: Db) {
    return db.collection('changedMessages');
}

export function getDeletedMsgCollection(db: Db) {
    return db.collection('deletedMessages');
}
