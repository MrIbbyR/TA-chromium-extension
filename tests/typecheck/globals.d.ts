// Globals the extension's scripts share across files (set by an earlier content
// script, read by a later one). Declared here so // @ts-check files can use them.

/** sr-selectors.js: SmartRecruiters selectors (string or priority list) and element ids. */
declare var __SR: typeof import("../../sr-selectors.js").SR | undefined;

/** keyword-*.js modules' shared exports in the browser. */
declare var __srKw: Record<string, any> | undefined;

/** keyword-expansions.js */
declare var KEYWORD_EXPANSIONS: Record<string, string[]>;
declare var KEYWORD_TYPO_ALIASES: Record<string, string>;
declare function buildExpansionTable(): Record<string, string[]>;
