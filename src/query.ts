import camelCase from "camelcase";
import decamelize from "decamelize";

export type QueryOptions = { caseSensitive: boolean };

export const defaultQueryOptions = { caseSensitive: false };

export const expandQuery = (query: string, options?: QueryOptions) => {
  let q = query.trim();
  q = q.startsWith("/") ? q.slice(1) : q;
  q = q.split(" ").length > 1 ? `${q.split(" ").join("*")}` : q;

  const queries = [
    ...new Set([
      q,
      camelCase(q),
      decamelize(q),
      decamelize(q, {
        separator: "-",
      }),
      ...(options?.caseSensitive ? [] : caseInsensitiveQuery(q)),
    ]),
  ];

  return `${
    queries.length > 1
      ? `{${queries.join(",")}}`
      : queries.length > 0
      ? queries[0]
      : ""
  }**`;
};

const caseInsensitiveQuery = (query: string) => {
  return [...query]
    .map((q) => {
      const l = q.toLowerCase();
      const u = q.toUpperCase();
      return l === u ? l : `[${q.toLowerCase()}${q.toUpperCase()}]`;
    })
    .join();
};
