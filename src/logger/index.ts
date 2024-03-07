import { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { mysql_debug, mysql_log_size, mysql_slow_query_warning, mysql_ui } from '../config';
import type { CFXCallback, CFXParameters } from '../types';
import { dbVersion } from '../database';

export function logError(
  invokingResource: string,
  cb: CFXCallback | undefined,
  isPromise: boolean | undefined,
  err: Error | string = '',
  query?: string,
  parameters?: CFXParameters,
  includeParameters?: boolean
) {
  const message = typeof err === 'object' ? err.message : err.replace(/SCRIPT ERROR: citizen:[\w\/\.]+:\d+[:\s]+/, '');

  const output = `${invokingResource} was unable to execute a query!${query ? `\n${`Query: ${query}`}` : ''}${
    includeParameters ? `\n${JSON.stringify(parameters)}` : ''
  }\n${message}`;

  TriggerEvent('oxmysql:error', {
    query: query,
    parameters: parameters,
    message: message,
    err: err,
    resource: invokingResource,
  });

  if (cb && isPromise) return cb(null, output);

  console.error(output);
}

export const profilerStatements = [
  'SET profiling_history_size = 0',
  'SET profiling = 0',
  'SET profiling_history_size = 100',
  'SET profiling = 1',
];

/**
 * Executes MySQL queries to fetch accurate query profiling results when `mysql_debug` is enabled.
 */
export async function runProfiler(connection: PoolConnection, invokingResource: string) {
  if (!mysql_debug) return;

  if (Array.isArray(mysql_debug) && !mysql_debug.includes(invokingResource)) return;

  for (const statement of profilerStatements) await connection.query(statement);

  return true;
}

export async function profileBatchStatements(
  connection: PoolConnection,
  invokingResource: string,
  query: string | { query: string; params?: CFXParameters }[],
  parameters: CFXParameters | null,
  offset: number
) {
  const [profiler] = <RowDataPacket[]>(
    await connection.query(
      'SELECT FORMAT(SUM(DURATION) * 1000, 4) AS `duration` FROM INFORMATION_SCHEMA.PROFILING GROUP BY QUERY_ID'
    )
  );

  for (const statement of profilerStatements) await connection.query(statement);

  if (profiler.length === 0) return;

  if (typeof query === 'string' && parameters)
    for (let i = 0; i < profiler.length; i++) {
      logQuery(invokingResource, query, parseFloat(profiler[i].duration), parameters[offset + i]);
    }
  else if (typeof query === 'object')
    for (let i = 0; i < profiler.length; i++) {
      const transaction = query[offset + i];
      if (transaction)
        logQuery(invokingResource, transaction.query, parseFloat(profiler[i].duration), transaction.params);
      else break;
    }
}

interface QueryData {
  date: number;
  query: string;
  executionTime: number;
  slow?: boolean;
}

type QueryLog = Record<string, QueryData[]>;

const logStorage: QueryLog = {};

export const logQuery = (
  invokingResource: string,
  query: string,
  executionTime: number,
  parameters?: CFXParameters
) => {
  if (
    executionTime >= mysql_slow_query_warning ||
    (mysql_debug && (!Array.isArray(mysql_debug) || mysql_debug.includes(invokingResource)))
  ) {
    console.log(
      `${dbVersion} ^3${invokingResource} took ${executionTime.toFixed(4)}ms to execute a query!\n${query}${
        parameters ? ` ${JSON.stringify(parameters)}` : ''
      }^0`
    );
  }

  if (!mysql_ui) return;

  if (!logStorage[invokingResource]) logStorage[invokingResource] = [];
  else if (logStorage[invokingResource].length > mysql_log_size) logStorage[invokingResource].splice(0, 1);

  logStorage[invokingResource].push({
    query,
    executionTime,
    date: Date.now(),
    slow: executionTime >= mysql_slow_query_warning ? true : undefined,
  });
};

RegisterCommand(
  'mysql',
  (source: number) => {
    if (!mysql_ui) return;

    if (source < 1) {
      // source is 0 when received from the server
      console.log('^3This command cannot run server side^0');
      return;
    }

    let totalQueries: number = 0;
    let totalTime = 0;
    let slowQueries = 0;
    let chartData: { labels: string[]; data: { queries: number; time: number }[] } = { labels: [], data: [] };

    for (const resource in logStorage) {
      const queries = logStorage[resource];
      let totalResourceTime = 0;

      totalQueries += queries.length;
      totalTime += queries.reduce((totalTime, query) => (totalTime += query.executionTime), 0);
      slowQueries += queries.reduce((slowQueries, query) => (slowQueries += query.slow ? 1 : 0), 0);
      totalResourceTime += queries.reduce((totalResourceTime, query) => (totalResourceTime += query.executionTime), 0);
      chartData.labels.push(resource);
      chartData.data.push({ queries: queries.length, time: totalResourceTime });
    }

    emitNet(`oxmysql:openUi`, source, {
      resources: Object.keys(logStorage),
      totalQueries,
      slowQueries,
      totalTime,
      chartData,
    });
  },
  true
);

const sortQueries = (queries: QueryData[], sort: { id: 'query' | 'executionTime'; desc: boolean }) => {
  const sortedQueries = [...queries].sort((a, b) => {
    switch (sort.id) {
      case 'query':
        return a.query > b.query ? 1 : -1;
      case 'executionTime':
        return a.executionTime - b.executionTime;
      default:
        return 0;
    }
  });

  return sort.desc ? sortedQueries.reverse() : sortedQueries;
};

onNet(
  `oxmysql:fetchResource`,
  (data: {
    resource: string;
    pageIndex: number;
    search: string;
    sortBy?: { id: 'query' | 'executionTime'; desc: boolean }[];
  }) => {
    if (typeof data.resource !== 'string' || !IsPlayerAceAllowed(source as unknown as string, 'command.mysql')) return;

    if (data.search) data.search = data.search.toLowerCase();

    const resourceLog = data.search
      ? logStorage[data.resource].filter((q) => q.query.toLowerCase().includes(data.search))
      : logStorage[data.resource];

    const sort = data.sortBy && data.sortBy.length > 0 ? data.sortBy[0] : false;
    const startRow = data.pageIndex * 10;
    const endRow = startRow + 10;
    const queries = sort ? sortQueries(resourceLog, sort).slice(startRow, endRow) : resourceLog.slice(startRow, endRow);
    const pageCount = Math.ceil(resourceLog.length / 10);

    if (!queries) return;

    let resourceTime = 0;
    let resourceSlowQueries = 0;
    const resourceQueriesCount = resourceLog.length;

    for (let i = 0; i < resourceQueriesCount; i++) {
      const query = resourceLog[i];

      resourceTime += query.executionTime;
      if (query.slow) resourceSlowQueries += 1;
    }

    emitNet(`oxmysql:loadResource`, source, {
      queries,
      pageCount,
      resourceQueriesCount,
      resourceSlowQueries,
      resourceTime,
    });
  }
);
