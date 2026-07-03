import ts from 'typescript';
import type { DomOperation, EventHandler, NetworkCall } from '../types/ir';

/**
 * String values assigned to named slots (variables, properties, object keys).
 * Collected for the hardcoded-secret rule; the rule itself lives in rules/secrets.ts.
 */
export interface StringAssignment {
  name: string;
  value: string;
  file: string;
  line: number;
}

export interface ScriptFacts {
  domOperations: DomOperation[];
  eventHandlers: EventHandler[];
  networkCalls: NetworkCall[];
  stringAssignments: StringAssignment[];
}

const DOM_METHODS = new Set([
  'getElementById',
  'querySelector',
  'querySelectorAll',
  'getElementsByClassName',
  'getElementsByTagName',
  'createElement',
  'write',
]);

const JQUERY_EVENT_METHODS = new Set([
  'click',
  'dblclick',
  'change',
  'submit',
  'keyup',
  'keydown',
  'keypress',
  'focus',
  'blur',
  'hover',
  'ready',
]);

const JQUERY_AJAX_METHODS = new Set(['ajax', 'get', 'post', 'getJSON']);

/**
 * Static analysis of one legacy script via the TypeScript compiler API
 * (which parses plain JS). Known limitation, documented deliberately: property
 * assignments like `el.textContent = ...` are DOM mutations but are not
 * recorded as domOperations — detecting them reliably needs type information.
 */
export function analyzeScript(code: string, file: string, lineOffset = 0): ScriptFacts {
  const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
  const facts: ScriptFacts = {
    domOperations: [],
    eventHandlers: [],
    networkCalls: [],
    stringAssignments: [],
  };

  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + lineOffset;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      collectFromCall(node, sourceFile, file, lineOf, facts);
    } else if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'XMLHttpRequest') {
        facts.networkCalls.push({ api: 'xhr', url: null, file, line: lineOf(node) });
      }
    } else if (ts.isVariableDeclaration(node)) {
      if (node.initializer && ts.isStringLiteralLike(node.initializer) && ts.isIdentifier(node.name)) {
        facts.stringAssignments.push({
          name: node.name.text,
          value: node.initializer.text,
          file,
          line: lineOf(node),
        });
      }
    } else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isStringLiteralLike(node.right)) {
        const lhs = node.left.getText(sourceFile);
        const name = lhs.includes('.') ? (lhs.split('.').pop() ?? lhs) : lhs;
        facts.stringAssignments.push({ name, value: node.right.text, file, line: lineOf(node) });
      }
    } else if (ts.isPropertyAssignment(node)) {
      if (ts.isStringLiteralLike(node.initializer) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
        facts.stringAssignments.push({
          name: node.name.text,
          value: node.initializer.text,
          file,
          line: lineOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return facts;
}

function isJqueryIdentifier(node: ts.Node): node is ts.Identifier {
  return ts.isIdentifier(node) && (node.text === '$' || node.text === 'jQuery');
}

/** `$(...)` — the jQuery factory call. */
function isJqueryFactoryCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && isJqueryIdentifier(node.expression);
}

/** First argument as static text: string literal contents, or identifier name (e.g. `document`). */
function firstArgText(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  if (!arg) return null;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isIdentifier(arg)) return arg.text;
  return null;
}

function collectFromCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  file: string,
  lineOf: (n: ts.Node) => number,
  facts: ScriptFacts,
): void {
  const line = lineOf(node);
  const callee = node.expression;

  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    const receiver = callee.expression;

    if (ts.isIdentifier(receiver) && receiver.text === 'document' && DOM_METHODS.has(method)) {
      facts.domOperations.push({ api: 'dom', method, target: firstArgText(node), file, line });
    } else if (method === 'addEventListener') {
      facts.eventHandlers.push({
        via: 'addEventListener',
        event: firstArgText(node) ?? 'unknown',
        target: receiver.getText(sourceFile),
        file,
        line,
      });
    } else if (isJqueryIdentifier(receiver) && JQUERY_AJAX_METHODS.has(method)) {
      facts.networkCalls.push({ api: 'jquery-ajax', url: extractAjaxUrl(node, method), file, line });
    } else if (isJqueryFactoryCall(receiver)) {
      const target = firstArgText(receiver);
      if (method === 'on') {
        facts.eventHandlers.push({ via: 'jquery', event: firstArgText(node) ?? 'unknown', target, file, line });
      } else if (JQUERY_EVENT_METHODS.has(method)) {
        facts.eventHandlers.push({ via: 'jquery', event: method, target, file, line });
      } else {
        facts.domOperations.push({ api: 'jquery', method, target, file, line });
      }
    }
  } else if (ts.isIdentifier(callee)) {
    if (callee.text === 'fetch') {
      facts.networkCalls.push({ api: 'fetch', url: firstStringArg(node), file, line });
    } else if (isJqueryIdentifier(callee) && !isChainedReceiver(node)) {
      // A bare `$(sel)` lookup not covered by a chained-method record above.
      facts.domOperations.push({ api: 'jquery', method: '$', target: firstArgText(node), file, line });
    }
  }
}

function firstStringArg(call: ts.CallExpression): string | null {
  const arg = call.arguments[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null;
}

/** True when this call is the receiver of a property access (`$(x).method(...)`). */
function isChainedReceiver(node: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node;
}

function extractAjaxUrl(call: ts.CallExpression, method: string): string | null {
  const arg = call.arguments[0];
  if (!arg) return null;
  if (method !== 'ajax') {
    return ts.isStringLiteralLike(arg) ? arg.text : null;
  }
  if (ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) &&
        prop.name.text === 'url' &&
        ts.isStringLiteralLike(prop.initializer)
      ) {
        return prop.initializer.text;
      }
    }
  }
  return null;
}
