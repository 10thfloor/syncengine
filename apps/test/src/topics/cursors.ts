import { topic, real, text } from '@syncengine/client';

export const cursorTopic = topic('cursors', {
    x: real(),
    y: real(),
    color: text(),
    userId: text(),
});
