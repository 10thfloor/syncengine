import { entity, integer, emit } from '@syncengine/core';

export const counter = entity('counter', {
  state: {
    value: integer(),
  },
  handlers: {
    increment: (state, amount: number) => emit(
      { ...state, value: state.value + amount },
      { table: 'clicks', record: { label: 'entity-increment', amount } },
    ),
    decrement: (state, amount: number) => ({
      ...state,
      value: state.value - amount,
    }),
    reset: (state) => ({
      ...state,
      value: 0,
    }),
  },
});
