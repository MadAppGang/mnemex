/**
 * SyntaxLine — shared syntax coloring + term highlighting component.
 * Used by ResultList (search results) and ResultDetailView (detail code).
 */

import { useMemo } from "react";
import { theme } from "../theme.js";
import { extname } from "node:path";

// ============================================================================
// Syntax color palette
// ============================================================================

export const SYNTAX_COLORS = {
	keyword: "#C678DD",
	string: "#98C379",
	comment: "#5C6370",
	number: "#D19A66",
	type: "#E5C07B",
	func: "#61AFEF",
	punctuation: "#ABB2BF",
} as const;

const JS_KEYWORDS = new Set([
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"export",
	"extends",
	"finally",
	"for",
	"from",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"let",
	"new",
	"of",
	"return",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"type",
	"interface",
	"enum",
	"implements",
	"namespace",
	"declare",
	"abstract",
	"private",
	"protected",
	"public",
	"readonly",
]);

const JS_LITERALS = new Set([
	"true",
	"false",
	"null",
	"undefined",
	"NaN",
	"Infinity",
]);

const PY_KEYWORDS = new Set([
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"True",
	"False",
	"None",
]);

// ============================================================================
// Types
// ============================================================================

export interface TextSegment {
	text: string;
	fg: string;
	bg?: string;
}

// ============================================================================
// Tokenizer
// ============================================================================

export function syntaxColorLine(line: string, lang: string): TextSegment[] {
	const keywords = lang === "python" ? PY_KEYWORDS : JS_KEYWORDS;
	const segments: TextSegment[] = [];
	const tokenPattern =
		/\/\/.*$|\/\*.*?\*\/|#.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_$][\w$]*\b|[^\s\w]+|\s+/g;

	let match: RegExpExecArray | null;
	while ((match = tokenPattern.exec(line)) !== null) {
		const token = match[0];
		if (
			token.startsWith("//") ||
			token.startsWith("/*") ||
			token.startsWith("#")
		) {
			segments.push({ text: token, fg: SYNTAX_COLORS.comment });
		} else if (
			(token.startsWith('"') && token.endsWith('"')) ||
			(token.startsWith("'") && token.endsWith("'")) ||
			(token.startsWith("`") && token.endsWith("`"))
		) {
			segments.push({ text: token, fg: SYNTAX_COLORS.string });
		} else if (/^\d/.test(token)) {
			segments.push({ text: token, fg: SYNTAX_COLORS.number });
		} else if (keywords.has(token)) {
			segments.push({ text: token, fg: SYNTAX_COLORS.keyword });
		} else if (JS_LITERALS.has(token)) {
			segments.push({ text: token, fg: SYNTAX_COLORS.number });
		} else if (/^[A-Z][\w]*$/.test(token)) {
			segments.push({ text: token, fg: SYNTAX_COLORS.type });
		} else if (/^[a-zA-Z_$]/.test(token)) {
			segments.push({ text: token, fg: theme.text });
		} else {
			segments.push({ text: token, fg: SYNTAX_COLORS.punctuation });
		}
	}
	return segments.length > 0 ? segments : [{ text: line, fg: theme.text }];
}

export function applyTermHighlights(
	segments: TextSegment[],
	terms: string[],
): TextSegment[] {
	if (terms.length === 0) return segments;
	const sorted = [...terms].sort((a, b) => b.length - a.length);
	const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pattern = new RegExp(`(${escaped.join("|")})`, "gi");

	const result: TextSegment[] = [];
	for (const seg of segments) {
		let lastIdx = 0;
		let m: RegExpExecArray | null;
		pattern.lastIndex = 0;
		let hadMatch = false;
		while ((m = pattern.exec(seg.text)) !== null) {
			hadMatch = true;
			if (m.index > lastIdx) {
				result.push({
					text: seg.text.slice(lastIdx, m.index),
					fg: seg.fg,
					bg: seg.bg,
				});
			}
			result.push({ text: m[0], fg: "#000000", bg: "#B8860B" });
			lastIdx = pattern.lastIndex;
		}
		if (hadMatch && lastIdx < seg.text.length) {
			result.push({ text: seg.text.slice(lastIdx), fg: seg.fg, bg: seg.bg });
		}
		if (!hadMatch) {
			result.push(seg);
		}
	}
	return result;
}

// ============================================================================
// Language detection helper
// ============================================================================

const LANG_MAP: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
};

export function detectLang(filePath: string): string {
	return LANG_MAP[extname(filePath).toLowerCase()] ?? "javascript";
}

// ============================================================================
// React component
// ============================================================================

export function SyntaxLine({
	line,
	terms,
	lang,
}: { line: string; terms?: string[]; lang: string }) {
	const segments = useMemo(() => {
		const syntaxSegs = syntaxColorLine(line, lang);
		return terms && terms.length > 0
			? applyTermHighlights(syntaxSegs, terms)
			: syntaxSegs;
	}, [line, terms, lang]);

	return (
		<box flexDirection="row">
			{segments.map((seg, i) =>
				seg.bg ? (
					<box key={i} backgroundColor={seg.bg}>
						<text fg={seg.fg}>{seg.text}</text>
					</box>
				) : (
					<text key={i} fg={seg.fg}>
						{seg.text}
					</text>
				),
			)}
		</box>
	);
}
