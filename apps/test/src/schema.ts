import { table, id, integer, text, view, sum, count } from '@syncengine/core';

export const clicks = table('clicks', {
    id: id(),
    label: text(),
    amount: integer(),
});

export const totalsView = view(clicks).aggregate([], {
    total: sum(clicks.amount),
    numClicks: count(),
});

export const channels = [
    { name: 'main', tables: [clicks] },
] as const;
