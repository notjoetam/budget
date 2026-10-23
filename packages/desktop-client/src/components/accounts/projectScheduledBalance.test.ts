import type { ScheduleStatuses } from '@actual-app/core/shared/schedules';
import type { ScheduleEntity } from '@actual-app/core/types/models';
import { describe, expect, it } from 'vitest';

import {
  buildWeeklyBalances,
  getScheduledChanges,
} from './projectScheduledBalance';

function makeSchedule(
  overrides: Partial<ScheduleEntity> & { date: unknown },
): ScheduleEntity {
  const { date, ...rest } = overrides;
  return {
    id: 'schedule',
    rule: 'rule',
    next_date: '2024-01-15',
    completed: false,
    posts_transaction: false,
    tombstone: false,
    _payee: 'payee',
    _account: 'checking',
    _amount: -1000,
    _amountOp: 'is',
    _date: date,
    _conditions: [{ op: 'is', field: 'date', value: date }],
    _actions: [],
    ...rest,
  } as ScheduleEntity;
}

const monthly = {
  start: '2024-01-15',
  frequency: 'monthly',
  interval: 1,
  patterns: [],
  skipWeekend: false,
  weekendSolveMode: 'after',
  endMode: 'never',
};

const noTransfers = () => null;

describe('getScheduledChanges', () => {
  it('lists recurring occurrences up to the end date', () => {
    const changes = getScheduledChanges({
      schedules: [makeSchedule({ date: monthly })],
      statuses: new Map(),
      accountIds: new Set(['checking']),
      getTransferAccountId: noTransfers,
      endDate: '2024-03-31',
      today: '2024-01-10',
    });

    expect([...changes]).toEqual([
      ['2024-01-15', -1000],
      ['2024-02-15', -1000],
      ['2024-03-15', -1000],
    ]);
  });

  it('keeps counting occurrences that move before a weekend', () => {
    const changes = getScheduledChanges({
      schedules: [
        makeSchedule({
          next_date: '2025-01-01',
          date: {
            ...monthly,
            start: '2025-01-01',
            skipWeekend: true,
            weekendSolveMode: 'before',
          },
        }),
      ],
      statuses: new Map(),
      accountIds: new Set(['checking']),
      getTransferAccountId: noTransfers,
      endDate: '2025-04-30',
      today: '2024-12-31',
    });

    // Feb 1 and Mar 1 2025 are Saturdays, so they move to Jan 31 and Feb 28
    expect([...changes]).toEqual([
      ['2025-01-01', -1000],
      ['2025-01-31', -1000],
      ['2025-02-28', -1000],
      ['2025-04-01', -1000],
    ]);
  });

  it('skips the next occurrence when it is already paid', () => {
    const changes = getScheduledChanges({
      schedules: [makeSchedule({ date: monthly })],
      statuses: new Map([['schedule', 'paid']]) as ScheduleStatuses,
      accountIds: new Set(['checking']),
      getTransferAccountId: noTransfers,
      endDate: '2024-02-29',
      today: '2024-01-20',
    });

    expect([...changes]).toEqual([['2024-02-15', -1000]]);
  });

  it('counts missed occurrences today', () => {
    const changes = getScheduledChanges({
      schedules: [
        makeSchedule({ date: '2023-12-20', next_date: '2023-12-20' }),
      ],
      statuses: new Map([['schedule', 'missed']]) as ScheduleStatuses,
      accountIds: new Set(['checking']),
      getTransferAccountId: noTransfers,
      endDate: '2024-03-31',
      today: '2024-01-10',
    });

    expect([...changes]).toEqual([['2024-01-10', -1000]]);
  });

  it('inverts transfers into the account and cancels transfers within the view', () => {
    const schedule = makeSchedule({
      date: '2024-02-01',
      next_date: '2024-02-01',
    });
    const getTransferAccountId = () => 'savings';

    expect([
      ...getScheduledChanges({
        schedules: [schedule],
        statuses: new Map(),
        accountIds: new Set(['savings']),
        getTransferAccountId,
        endDate: '2024-03-31',
        today: '2024-01-10',
      }),
    ]).toEqual([['2024-02-01', 1000]]);

    expect([
      ...getScheduledChanges({
        schedules: [schedule],
        statuses: new Map(),
        accountIds: new Set(['checking', 'savings']),
        getTransferAccountId,
        endDate: '2024-03-31',
        today: '2024-01-10',
      }),
    ]).toEqual([]);
  });

  it('ignores completed schedules and occurrences past the end date', () => {
    const changes = getScheduledChanges({
      schedules: [
        makeSchedule({ id: 'done', date: monthly, completed: true }),
        makeSchedule({
          id: 'later',
          date: '2024-06-01',
          next_date: '2024-06-01',
        }),
      ],
      statuses: new Map(),
      accountIds: new Set(['checking']),
      getTransferAccountId: noTransfers,
      endDate: '2024-03-31',
      today: '2024-01-10',
    });

    expect([...changes]).toEqual([]);
  });
});

describe('buildWeeklyBalances', () => {
  it('builds weekly balances followed by a projection', () => {
    const balances = buildWeeklyBalances({
      startingBalance: 1000,
      dailyTotals: new Map([
        ['2024-01-02', 500],
        ['2024-01-09', -200],
        // Already posted for later this week and next week
        ['2024-01-12', -100],
        ['2024-01-16', 50],
      ]),
      scheduledChanges: new Map([
        ['2024-01-11', -300],
        ['2024-01-25', -400],
      ]),
      startDate: '2023-12-31',
      endDate: '2024-01-27',
      firstDayOfWeekIdx: '0',
      today: '2024-01-10',
    });

    expect(balances).toEqual([
      { week: '2023-12-31', balance: 1500 },
      { week: '2024-01-07', balance: 1200, projected: 1200 },
      { week: '2024-01-14', projected: 950 },
      { week: '2024-01-21', projected: 550 },
    ]);
  });

  it('leaves out the projection when nothing is expected to change', () => {
    const balances = buildWeeklyBalances({
      startingBalance: 1000,
      dailyTotals: new Map([['2024-01-02', 500]]),
      scheduledChanges: new Map(),
      startDate: '2023-12-31',
      endDate: '2024-01-27',
      firstDayOfWeekIdx: '0',
      today: '2024-01-10',
    });

    expect(balances).toEqual([
      { week: '2023-12-31', balance: 1500 },
      { week: '2024-01-07', balance: 1500 },
    ]);
  });

  it('starts weeks on the configured first day of the week', () => {
    const balances = buildWeeklyBalances({
      startingBalance: 0,
      dailyTotals: new Map([
        // A Sunday, which ends a Monday-based week
        ['2024-01-07', 100],
        ['2024-01-08', 10],
      ]),
      scheduledChanges: new Map(),
      startDate: '2024-01-01',
      endDate: '2024-01-10',
      firstDayOfWeekIdx: '1',
      today: '2024-01-10',
    });

    expect(balances).toEqual([
      { week: '2024-01-01', balance: 100 },
      { week: '2024-01-08', balance: 110 },
    ]);
  });
});
