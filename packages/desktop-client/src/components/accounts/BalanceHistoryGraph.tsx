import React, { useEffect, useId, useMemo, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import { Trans } from 'react-i18next';
import { AutoSizer } from 'react-virtualized-auto-sizer';

import { SpaceBetween } from '@actual-app/components/space-between';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import { getUpcomingDays } from '@actual-app/core/shared/schedules';
import { integerToCurrency } from '@actual-app/core/shared/util';
import type { AccountEntity } from '@actual-app/core/types/models';
import { subMonths } from 'date-fns';
import {
  Area,
  AreaChart,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  YAxis,
} from 'recharts';

import { PrivacyFilter } from '#components/PrivacyFilter';
import { useRechartsAnimation } from '#components/reports/chart-theme';
import { LoadingIndicator } from '#components/reports/LoadingIndicator';
import { useAccounts } from '#hooks/useAccounts';
import { useLocale } from '#hooks/useLocale';
import { usePayees } from '#hooks/usePayees';
import { getSchedulesQuery, useSchedules } from '#hooks/useSchedules';
import { useSyncedPref } from '#hooks/useSyncedPref';
import * as query from '#queries';
import { liveQuery } from '#queries/liveQuery';

import {
  buildWeeklyBalances,
  getScheduledChanges,
} from './projectScheduledBalance';

const LABEL_WIDTH = 70;
const CHART_MARGIN = { top: 5, right: 5, bottom: 5, left: 5 };
const HISTORY_MONTHS = 12;
const NO_SCHEDULED_CHANGES = new Map<string, number>();

type BalancePoint = {
  date: string;
  balance?: number;
  projected?: number;
};

type BalanceHistoryGraphProps = {
  accountId?: string;
  showProjection?: boolean;
  style?: CSSProperties;
  ref?: Ref<HTMLDivElement>;
};

export function BalanceHistoryGraph({
  accountId,
  showProjection = false,
  style,
  ref,
}: BalanceHistoryGraphProps) {
  const locale = useLocale();
  const animationProps = useRechartsAnimation({ isAnimationActive: false });
  const [firstDayOfWeekIdx] = useSyncedPref('firstDayOfWeekIdx');
  const [hoveredValue, setHoveredValue] = useState<BalancePoint | null>(null);
  const [startingBalance, setStartingBalance] = useState<number | null>(null);
  const [dailyTotals, setDailyTotals] = useState<Map<string, number> | null>(
    null,
  );
  const [hasError, setHasError] = useState(false);

  const today = monthUtils.currentDay();
  const startDate = monthUtils.weekFromDate(
    subMonths(monthUtils.parseDate(today), HISTORY_MONTHS),
    firstDayOfWeekIdx,
  );
  // Project as far ahead as the upcoming scheduled transactions setting
  const [upcomingLength] = useSyncedPref('upcomingScheduledTransactionLength');
  const endDate = monthUtils.addDays(today, getUpcomingDays(upcomingLength));

  const isProjectionEnabled =
    showProjection && accountId !== 'closed' && accountId !== 'uncategorized';
  const schedulesQuery = useMemo(
    () => (isProjectionEnabled ? getSchedulesQuery(accountId) : undefined),
    [isProjectionEnabled, accountId],
  );
  const { schedules, statuses } = useSchedules({ query: schedulesQuery });
  const { data: accounts } = useAccounts();
  const { data: payees } = usePayees();

  const scheduledChanges = useMemo(() => {
    if (!isProjectionEnabled || !accounts || !payees) {
      return NO_SCHEDULED_CHANGES;
    }

    const accountIds = new Set(
      accounts
        .filter(account => isAccountInView(account, accountId))
        .map(account => account.id),
    );
    const transferAccountByPayee = new Map(
      payees.map(payee => [payee.id, payee.transfer_acct ?? null]),
    );

    return getScheduledChanges({
      schedules,
      statuses,
      accountIds,
      getTransferAccountId: payeeId =>
        (payeeId && transferAccountByPayee.get(payeeId)) || null,
      endDate,
    });
  }, [
    isProjectionEnabled,
    accounts,
    payees,
    schedules,
    statuses,
    accountId,
    endDate,
  ]);

  const loading =
    !hasError && (startingBalance === null || dailyTotals === null);

  const balanceData = useMemo((): BalancePoint[] => {
    if (startingBalance === null || dailyTotals === null) {
      return [];
    }

    return buildWeeklyBalances({
      startingBalance,
      dailyTotals,
      scheduledChanges,
      startDate,
      endDate,
      firstDayOfWeekIdx,
    }).map(({ week, balance, projected }) => ({
      // Each point is the balance at the end of its week
      date: monthUtils.format(
        monthUtils.addDays(week, 6),
        'MMM d, yyyy',
        locale,
      ),
      balance,
      projected,
    }));
  }, [
    startingBalance,
    dailyTotals,
    scheduledChanges,
    startDate,
    endDate,
    firstDayOfWeekIdx,
    locale,
  ]);

  const actualData = balanceData.filter(d => d.balance != null);
  const latestPoint = actualData[actualData.length - 1] ?? null;
  const displayedValue = hoveredValue ?? latestPoint;

  const percentageChange = getPercentageChange(actualData);
  const color = percentageChange >= 0 ? theme.noticeTextLight : theme.errorText;

  // Always include zero so the zero line is visible
  const values = balanceData.flatMap(point =>
    [point.balance, point.projected].filter(value => value != null),
  );
  const domainMin = Math.min(0, ...values);
  const domainMax = Math.max(0, ...values);
  // Where zero sits on the chart, as a fraction of its full height
  function getZeroOffset(height: number) {
    if (domainMax === domainMin) {
      return 1;
    }
    const plotHeight = height - CHART_MARGIN.top - CHART_MARGIN.bottom;
    const zeroY =
      CHART_MARGIN.top + (domainMax / (domainMax - domainMin)) * plotHeight;
    return zeroY / height;
  }

  const gradientId = useId().replace(/:/g, '');
  const strokeGradientId = `balance-stroke-${gradientId}`;
  const fillGradientId = `balance-fill-${gradientId}`;

  useEffect(() => {
    // Reset state when the account or date range changes
    setStartingBalance(null);
    setDailyTotals(null);
    setHoveredValue(null);
    setHasError(false);

    const startingBalanceQuery = query
      .transactions(accountId)
      .filter({ date: { $lt: startDate } })
      .calculate({ $sum: '$amount' });
    const dailyTotalsQuery = query
      .transactions(accountId)
      .filter({
        $and: [{ date: { $gte: startDate } }, { date: { $lte: endDate } }],
      })
      .groupBy(['date'])
      .select(['date', { amount: { $sum: '$amount' } }]);

    const startingBalanceLive: ReturnType<typeof liveQuery<number>> = liveQuery(
      startingBalanceQuery,
      {
        onData: (data: number[]) => {
          setStartingBalance(data[0] || 0);
        },
        onError: error => {
          console.error('Error fetching starting balance:', error);
          setHasError(true);
        },
      },
    );

    const dailyTotalsLive: ReturnType<
      typeof liveQuery<{ date: string; amount: number }>
    > = liveQuery(dailyTotalsQuery, {
      onData: (data: Array<{ date: string; amount: number }>) => {
        setDailyTotals(new Map(data.map(d => [d.date, d.amount])));
      },
      onError: error => {
        console.error('Error fetching daily totals:', error);
        setHasError(true);
      },
    });

    return () => {
      startingBalanceLive?.unsubscribe();
      dailyTotalsLive?.unsubscribe();
    };
  }, [accountId, startDate, endDate]);

  // State to track if the chart is hovered (used to conditionally render PrivacyFilter)
  const [isHovered, setIsHovered] = useState(false);

  return (
    <View ref={ref} style={{ margin: 10, ...style }}>
      <AutoSizer
        renderProp={({ width = 0, height = 0 }) => {
          if (width === 0 || height === 0) {
            return null;
          }

          if (loading) {
            return (
              <div style={{ width, height }}>
                <LoadingIndicator />
              </div>
            );
          }

          return (
            <View style={{ width }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'stretch',
                  justifyContent: 'space-between',
                }}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => {
                  setIsHovered(false);
                  setHoveredValue(null);
                }}
              >
                <AreaChart
                  data={balanceData}
                  width={width - LABEL_WIDTH}
                  height={height}
                  margin={CHART_MARGIN}
                >
                  <defs>
                    {/* Split the colors where the balance crosses zero */}
                    <linearGradient
                      id={strokeGradientId}
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2={height}
                    >
                      <stop
                        offset={getZeroOffset(height)}
                        stopColor={theme.noticeTextLight}
                      />
                      <stop
                        offset={getZeroOffset(height)}
                        stopColor={theme.errorText}
                      />
                    </linearGradient>
                    <linearGradient
                      id={fillGradientId}
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2={height}
                    >
                      <stop
                        offset={0}
                        stopColor={theme.noticeTextLight}
                        stopOpacity={1}
                      />
                      <stop
                        offset={getZeroOffset(height)}
                        stopColor={theme.noticeTextLight}
                        stopOpacity={0.2}
                      />
                      <stop
                        offset={getZeroOffset(height)}
                        stopColor={theme.errorText}
                        stopOpacity={0.2}
                      />
                      <stop
                        offset={1}
                        stopColor={theme.errorText}
                        stopOpacity={1}
                      />
                    </linearGradient>
                  </defs>
                  <YAxis domain={[domainMin, domainMax]} hide />
                  <ReferenceLine
                    y={0}
                    stroke={theme.pageTextSubdued}
                    strokeOpacity={0.5}
                    ifOverflow="extendDomain"
                  />
                  <RechartsTooltip
                    contentStyle={{
                      display: 'none',
                    }}
                    labelFormatter={(label, items) => {
                      const data = items[0]?.payload;
                      if (data) {
                        setHoveredValue(data);
                      }
                      return '';
                    }}
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="balance"
                    stroke={`url(#${strokeGradientId})`}
                    strokeWidth={2}
                    {...animationProps}
                    fill={`url(#${fillGradientId})`}
                  />
                  <Area
                    type="monotone"
                    dataKey="projected"
                    stroke={`url(#${strokeGradientId})`}
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    strokeOpacity={0.6}
                    {...animationProps}
                    fill="none"
                  />
                </AreaChart>

                <SpaceBetween
                  direction="vertical"
                  style={{
                    alignItems: 'flex-end',
                    justifyContent: 'space-between',
                    width: LABEL_WIDTH,
                    textAlign: 'right',
                    ...styles.verySmallText,
                  }}
                >
                  {percentageChange === 0 ? (
                    <div />
                  ) : (
                    <Text style={{ color }}>
                      {percentageChange >= 0 ? '+' : ''}
                      {percentageChange.toFixed(1)}%
                    </Text>
                  )}

                  {displayedValue && (
                    <View>
                      <Text style={{ fontWeight: 800 }}>
                        {displayedValue.date}
                      </Text>
                      {displayedValue.balance == null && (
                        <Text style={{ fontStyle: 'italic' }}>
                          <Trans>Projected</Trans>
                        </Text>
                      )}
                      <PrivacyFilter activationFilters={[() => !isHovered]}>
                        <Text>
                          {integerToCurrency(
                            displayedValue.balance ??
                              displayedValue.projected ??
                              0,
                          )}
                        </Text>
                      </PrivacyFilter>
                    </View>
                  )}
                </SpaceBetween>
              </div>
            </View>
          );
        }}
      />
    </View>
  );
}

function isAccountInView(account: AccountEntity, view: string | undefined) {
  switch (view) {
    case undefined:
      return !account.closed;
    case 'onbudget':
      return !account.closed && !account.offbudget;
    case 'offbudget':
      return !account.closed && !!account.offbudget;
    default:
      return account.id === view;
  }
}

function getPercentageChange(actualData: BalancePoint[]) {
  if (actualData.length < 2) return 0;
  const firstBalance = actualData[0].balance ?? 0;
  const lastBalance = actualData[actualData.length - 1].balance ?? 0;
  if (firstBalance === 0) return 0;
  return ((lastBalance - firstBalance) / Math.abs(firstBalance)) * 100;
}
