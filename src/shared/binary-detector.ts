/**
 * Binary File Detector
 *
 * Detects whether a file is binary (vs text) using extension lookup
 * and null-byte scanning. Also provides extension-to-language mapping.
 */

import { openSync, readSync, closeSync } from "node:fs";

// ============================================================================
// Constants
// ============================================================================

/**
 * Set of file extensions that are known to be text files.
 * Files with these extensions are assumed to be readable text without
 * further content scanning.
 */
export const TEXT_EXTENSIONS = new Set([
	// Documentation and markup
	".txt",
	".md",
	".mdx",
	".rst",
	".adoc",
	".asciidoc",
	".tex",
	".latex",

	// Data formats
	".json",
	".jsonc",
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".conf",
	".csv",
	".tsv",
	".xml",
	".xsd",
	".dtd",

	// Web
	".html",
	".htm",
	".xhtml",
	".svg",
	".css",
	".scss",
	".sass",
	".less",
	".styl",

	// Scripts and shells
	".sh",
	".bash",
	".zsh",
	".fish",
	".ksh",
	".csh",
	".bat",
	".cmd",
	".ps1",
	".psm1",

	// Database
	".sql",
	".pgsql",
	".mysql",

	// API definitions
	".graphql",
	".gql",
	".proto",
	".thrift",
	".avsc",
	".avro",

	// Infrastructure / IaC
	".tf",
	".tfvars",
	".hcl",
	".dockerfile",
	".makefile",

	// Config files (no extension or dotfiles)
	".editorconfig",
	".gitignore",
	".gitattributes",
	".gitmodules",
	".npmrc",
	".yarnrc",
	".nvmrc",
	".node-version",
	".env",
	".env.example",
	".env.local",
	".env.template",
	".eslintrc",
	".prettierrc",
	".babelrc",
	".stylelintrc",
	".browserslistrc",
	".htaccess",

	// TypeScript/JavaScript ecosystem
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".d.ts",

	// Web frameworks
	".vue",
	".svelte",
	".astro",

	// Backend languages
	".py",
	".rb",
	".php",
	".java",
	".kt",
	".kts",
	".groovy",
	".gradle",
	".go",
	".rs",
	".c",
	".cc",
	".cpp",
	".cxx",
	".h",
	".hh",
	".hpp",
	".hxx",
	".cs",
	".fs",
	".fsx",
	".vb",
	".swift",
	".m",
	".mm",

	// Functional languages
	".hs",
	".lhs",
	".elm",
	".ex",
	".exs",
	".erl",
	".hrl",
	".clj",
	".cljs",
	".cljc",
	".scala",
	".sbt",
	".ml",
	".mli",
	".re",
	".rei",
	".rkt",
	".lisp",
	".cl",
	".scm",

	// Systems languages
	".zig",
	".nim",
	".cr",
	".d",

	// Scripting
	".lua",
	".pl",
	".pm",
	".r",
	".R",
	".jl",

	// Database / ORM
	".prisma",

	// Templates
	".ejs",
	".hbs",
	".handlebars",
	".mustache",
	".pug",
	".jade",
	".njk",
	".jinja",
	".jinja2",
	".twig",
	".liquid",

	// Other
	".lock",
	".sum",
	".mod",
	".gemspec",
	".podspec",
]);

/**
 * Binary file extensions to always skip.
 * These are checked before text extension lookup.
 */
const BINARY_EXTENSIONS = new Set([
	// Images
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".webp",
	".tiff",
	".tif",
	".avif",
	".heic",

	// Video
	".mp4",
	".avi",
	".mov",
	".mkv",
	".webm",
	".flv",
	".wmv",
	".m4v",

	// Audio
	".mp3",
	".wav",
	".flac",
	".ogg",
	".m4a",
	".aac",
	".wma",

	// Archives
	".zip",
	".tar",
	".gz",
	".bz2",
	".xz",
	".7z",
	".rar",
	".jar",
	".war",
	".ear",

	// Compiled / binary
	".exe",
	".dll",
	".so",
	".dylib",
	".a",
	".o",
	".obj",
	".class",
	".pyc",
	".pyo",
	".pyd",
	".wasm",
	".node",

	// Documents
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".odt",
	".ods",
	".odp",

	// Fonts
	".ttf",
	".otf",
	".woff",
	".woff2",
	".eot",

	// Data
	".db",
	".sqlite",
	".sqlite3",
	".parquet",
	".feather",
	".npy",
	".npz",

	// Lock files (binary)
	".lockb",

	// Misc
	".map",
]);

/** Number of bytes to scan for null bytes to detect binary content */
const BINARY_SCAN_BYTES = 8192;

// ============================================================================
// Functions
// ============================================================================

/**
 * Check whether a file is binary.
 *
 * Detection strategy:
 * 1. If extension is in BINARY_EXTENSIONS → binary
 * 2. If extension is in TEXT_EXTENSIONS → text
 * 3. Otherwise scan first BINARY_SCAN_BYTES bytes for null bytes → binary if found
 *
 * @param filePath - Absolute path to the file
 * @param ext - File extension including dot (e.g., ".ts")
 * @returns true if the file is binary
 */
export function isBinaryFile(filePath: string, ext: string): boolean {
	const lowerExt = ext.toLowerCase();

	// Fast path: known binary extension
	if (BINARY_EXTENSIONS.has(lowerExt)) {
		return true;
	}

	// Fast path: known text extension
	if (TEXT_EXTENSIONS.has(lowerExt)) {
		return false;
	}

	// Unknown extension: scan first BINARY_SCAN_BYTES bytes for null bytes
	try {
		const fd = openSync(filePath, "r");
		const buf = Buffer.alloc(BINARY_SCAN_BYTES);
		const bytesRead = readSync(fd, buf, 0, BINARY_SCAN_BYTES, 0);
		closeSync(fd);
		const slice = buf.subarray(0, bytesRead);
		for (let i = 0; i < slice.length; i++) {
			if (slice[i] === 0) {
				return true;
			}
		}
		return false;
	} catch {
		// If we can't read it, treat as binary to skip safely
		return true;
	}
}

// ============================================================================
// Extension to Language Mapping
// ============================================================================

/**
 * Map a file extension to a language identifier for syntax highlighting.
 * Returns undefined for unknown extensions.
 */
export function extensionToLanguage(ext: string): string | undefined {
	const map: Record<string, string> = {
		// TypeScript / JavaScript
		".ts": "typescript",
		".tsx": "tsx",
		".mts": "typescript",
		".cts": "typescript",
		".js": "javascript",
		".jsx": "jsx",
		".mjs": "javascript",
		".cjs": "javascript",
		".d.ts": "typescript",

		// Web
		".html": "html",
		".htm": "html",
		".xhtml": "html",
		".svg": "svg",
		".css": "css",
		".scss": "scss",
		".sass": "sass",
		".less": "less",
		".styl": "stylus",
		".vue": "vue",
		".svelte": "svelte",
		".astro": "astro",

		// Python
		".py": "python",
		".pyi": "python",

		// Ruby
		".rb": "ruby",
		".erb": "erb",

		// PHP
		".php": "php",

		// Go
		".go": "go",

		// Rust
		".rs": "rust",

		// Java / JVM
		".java": "java",
		".kt": "kotlin",
		".kts": "kotlin",
		".groovy": "groovy",
		".gradle": "groovy",
		".scala": "scala",
		".sbt": "scala",

		// C / C++
		".c": "c",
		".cc": "cpp",
		".cpp": "cpp",
		".cxx": "cpp",
		".h": "c",
		".hh": "cpp",
		".hpp": "cpp",
		".hxx": "cpp",

		// C# / .NET
		".cs": "csharp",
		".fs": "fsharp",
		".fsx": "fsharp",
		".vb": "vbnet",

		// Swift / ObjC
		".swift": "swift",
		".m": "objectivec",
		".mm": "objectivecpp",

		// Functional
		".hs": "haskell",
		".lhs": "haskell",
		".elm": "elm",
		".ex": "elixir",
		".exs": "elixir",
		".erl": "erlang",
		".hrl": "erlang",
		".clj": "clojure",
		".cljs": "clojurescript",
		".cljc": "clojure",
		".ml": "ocaml",
		".mli": "ocaml",
		".re": "reason",
		".rei": "reason",
		".rkt": "racket",
		".lisp": "lisp",
		".cl": "commonlisp",
		".scm": "scheme",

		// Systems
		".zig": "zig",
		".nim": "nim",
		".cr": "crystal",
		".d": "d",

		// Scripting
		".lua": "lua",
		".pl": "perl",
		".pm": "perl",
		".r": "r",
		".R": "r",
		".jl": "julia",
		".sh": "bash",
		".bash": "bash",
		".zsh": "zsh",
		".fish": "fish",
		".ksh": "bash",
		".ps1": "powershell",

		// Data / Config
		".json": "json",
		".jsonc": "jsonc",
		".yaml": "yaml",
		".yml": "yaml",
		".toml": "toml",
		".ini": "ini",
		".xml": "xml",
		".xsd": "xml",
		".csv": "csv",
		".sql": "sql",
		".graphql": "graphql",
		".gql": "graphql",
		".proto": "protobuf",

		// Infrastructure
		".tf": "hcl",
		".hcl": "hcl",
		".dockerfile": "dockerfile",

		// Documentation
		".md": "markdown",
		".mdx": "mdx",
		".rst": "rst",
		".tex": "latex",

		// Database / ORM
		".prisma": "prisma",

		// Templates
		".ejs": "ejs",
		".hbs": "handlebars",
		".mustache": "mustache",
		".pug": "pug",
		".njk": "nunjucks",
		".jinja": "jinja",
		".jinja2": "jinja",
		".liquid": "liquid",
	};

	return map[ext.toLowerCase()];
}
