import * as monthUtils from '@actual-app/core/shared/months';
import {
  extractScheduleConds,
  getNextDate,
  getScheduledAmount,
  scheduleIsRecurring,
} from '@actual-app/core/shared/schedules';
import type { ScheduleStatuses } from '@actual-app/core/shared/schedules';
import type {
  AccountEntity,
  PayeeEntity,
  ScheduleEntity,
} from '@actual-app/core/types/models';
import type { SyncedPrefs } from '@actual-app/core/types/prefs';

type ScheduledChangesProps = {
  schedules: readonly ScheduleEntity[];
  statuses: ScheduleStatuses;
  accountIds: ReadonlySet<AccountEntity['id']>;
  getTransferAccountId: (
    payeeId: PayeeEntity['id'] | null | undefined,
  ) => AccountEntity['id'] | null;
  endDate: string;
  today?: string;
};

/**
 * Sum the scheduled transactions that have not been posted yet, per day,
 * for the given accounts. Missed occurrences are counted today since they
 * are still expected to post.
 */
export function getScheduledChanges({
  schedules,
  statuses,
  accountIds,
  getTransferAccountId,
  endDate,
  today = monthUtils.currentDay(),
}: ScheduledChangesProps): Map<string, number> {
  const changes = new Map<string, number>();

  for (const schedule of schedules) {
    if (schedule.completed || !schedule.next_date) {
      continue;
    }

    const amount = getScheduledAmount(schedule._amount);
    const transferAccountId = getTransferAccountId(schedule._payee);
    let change = 0;
    if (accountIds.has(schedule._account)) {
      change += amount;
    }
    if (transferAccountId && accountIds.has(transferAccountId)) {
      change -= amount;
    }
    if (change === 0) {
      continue;
    }

    const dates = getOccurrenceDates(schedule, endDate);
    if (statuses.get(schedule.id) === 'paid') {
      dates.shift();
    }

    for (const date of dates) {
      const day = date < today ? today : date;
      changes.set(day, (changes.get(day) ?? 0) + change);
    }
  }

  return changes;
}

function getOccurrenceDates(schedule: ScheduleEntity, endDate: string) {
  const dates = [schedule.next_date];
  if (schedule.next_date > endDate) {
    return [];
  }

  const { date: dateCond } = extractScheduleConds(schedule._conditions);
  if (!scheduleIsRecurring(dateCond)) {
    return dates;
  }

  // Step through the dates before weekend skipping, since a skipped date
  // can move before the day we searched from
  let day = monthUtils.addDays(schedule.next_date, 1);
  while (day <= endDate) {
    const rawDate = getNextDate(dateCond, monthUtils.parseDate(day), true);
    if (rawDate === null || rawDate < day) {
      break;
    }
    const nextDate = getNextDate(dateCond, monthUtils.parseDate(rawDate));
    if (nextDate === null || nextDate > endDate) {
      break;
    }
    if (!dates.includes(nextDate)) {
      dates.push(nextDate);
    }
    day = monthUtils.addDays(rawDate, 1);
  }

  return dates;
}

export type WeeklyBalance = {
  week: string;
  balance?: number;
  projected?: number;
};

type WeeklyBalancesProps = {
  startingBalance: number;
  dailyTotals: ReadonlyMap<string, number>;
  scheduledChanges: ReadonlyMap<string, number>;
  startDate: string;
  endDate: string;
  firstDayOfWeekIdx: SyncedPrefs['firstDayOfWeekIdx'];
  today?: string;
};

/**
 * Build the end of week balances from `startDate` up to the current week,
 * followed by projected balances up to `endDate` when anything is expected
 * to change after the current week's balance.
 */
export function buildWeeklyBalances({
  startingBalance,
  dailyTotals,
  scheduledChanges,
  startDate,
  endDate,
  firstDayOfWeekIdx,
  today = monthUtils.currentDay(),
}: WeeklyBalancesProps): WeeklyBalance[] {
  const toWeek = (date: string) =>
    monthUtils.weekFromDate(date, firstDayOfWeekIdx);
  const currentWeek = toWeek(today);

  const postedByWeek = sumByWeek(dailyTotals, toWeek);
  const scheduledByWeek = sumByWeek(scheduledChanges, toWeek);

  const balances: WeeklyBalance[] = [];
  let balance = startingBalance;
  let week = toWeek(startDate);
  for (; week <= currentWeek; week = monthUtils.addDays(week, 7)) {
    balance += postedByWeek.get(week) ?? 0;
    balances.push({ week, balance });
  }

  // Scheduled transactions left in the current week show up in the next
  // projected point, so the current point matches the posted balance
  const projections: WeeklyBalance[] = [];
  let projected = balance + (scheduledByWeek.get(currentWeek) ?? 0);
  let hasProjection = projected !== balance;
  for (; week <= toWeek(endDate); week = monthUtils.addDays(week, 7)) {
    const change =
      (postedByWeek.get(week) ?? 0) + (scheduledByWeek.get(week) ?? 0);
    projected += change;
    hasProjection ||= change !== 0;
    projections.push({ week, projected });
  }

  if (hasProjection && balances.length > 0) {
    balances[balances.length - 1].projected = balance;
    balances.push(...projections);
  }

  return balances;
}

function sumByWeek(
  totals: ReadonlyMap<string, number>,
  toWeek: (date: string) => string,
) {
  const byWeek = new Map<string, number>();
  for (const [date, amount] of totals) {
    const week = toWeek(date);
    byWeek.set(week, (byWeek.get(week) ?? 0) + amount);
  }
  return byWeek;
}
