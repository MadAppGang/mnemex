/**
 * Test File Detector
 *
 * Language-aware detection of test files and test symbols.
 * Centralizes test identification logic for dead-code and test-gaps analysis.
 */

// ============================================================================
// Types
// ============================================================================

export interface TestPattern {
	/** File path patterns (glob-like) */
	filePatterns: RegExp[];
	/** Directory patterns */
	dirPatterns: RegExp[];
	/** Symbol name patterns (for test functions) */
	symbolPatterns?: RegExp[];
}

export type SupportedLanguage =
	| "typescript"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "java"
	| "c"
	| "cpp"
	| "dingo";

// ============================================================================
// Language-Specific Test Patterns
// ============================================================================

const TEST_PATTERNS: Record<SupportedLanguage, TestPattern> = {
	typescript: {
		filePatterns: [
			/\.test\.[tj]sx?$/,
			/\.spec\.[tj]sx?$/,
			/_test\.[tj]sx?$/,
			/_spec\.[tj]sx?$/,
		],
		dirPatterns: [/__tests__\//, /\/test\//, /\/tests\//, /\/testing\//],
		symbolPatterns: [
			/^test_/i,
			/^it$/,
			/^describe$/,
			/^beforeEach$/,
			/^afterEach$/,
			/^beforeAll$/,
			/^afterAll$/,
		],
	},
	javascript: {
		filePatterns: [
			/\.test\.jsx?$/,
			/\.spec\.jsx?$/,
			/_test\.jsx?$/,
			/_spec\.jsx?$/,
		],
		dirPatterns: [/__tests__\//, /\/test\//, /\/tests\//, /\/testing\//],
		symbolPatterns: [/^test_/i, /^it$/, /^describe$/],
	},
	python: {
		filePatterns: [/^test_.*\.py$/, /.*_test\.py$/, /test\.py$/],
		dirPatterns: [/\/tests?\//, /\/testing\//],
		symbolPatterns: [/^test_/, /^Test[A-Z]/],
	},
	go: {
		filePatterns: [/_test\.go$/],
		dirPatterns: [/\/testdata\//],
		symbolPatterns: [/^Test[A-Z]/, /^Benchmark[A-Z]/, /^Example[A-Z]/],
	},
	rust: {
		filePatterns: [/_test\.rs$/, /tests\.rs$/],
		dirPatterns: [/\/tests\//],
		symbolPatterns: [/^test_/],
	},
	java: {
		filePatterns: [
			/Test\.java$/,
			/Tests\.java$/,
			/TestCase\.java$/,
			/IT\.java$/,
		],
		dirPatterns: [/\/test\//, /\/tests\//, /src\/test\//],
		symbolPatterns: [/^test[A-Z]/, /^should[A-Z]/],
	},
	c: {
		filePatterns: [/_test\.c$/, /test_.*\.c$/, /_tests\.c$/],
		dirPatterns: [/\/tests?\//],
		symbolPatterns: [/^test_/, /^Test_/],
	},
	cpp: {
		filePatterns: [
			/_test\.cpp$/,
			/_test\.cc$/,
			/_test\.cxx$/,
			/test_.*\.cpp$/,
			/Test\.cpp$/,
		],
		dirPatterns: [/\/tests?\//, /\/gtest\//],
		symbolPatterns: [/^TEST$/, /^TEST_F$/, /^test_/i],
	},
	dingo: {
		filePatterns: [/_test\.dingo$/, /^test_.*\.dingo$/],
		dirPatterns: [/\/testdata\//],
		symbolPatterns: [/^Test[A-Z]/, /^Benchmark[A-Z]/, /^Example[A-Z]/],
	},
};

// Extension to language mapping
const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".dingo": "dingo",
};

// ============================================================================
// Test File Detector Class
// ============================================================================

export class TestFileDetector {
	private customPatterns: TestPattern | null = null;

	/**
	 * Set custom test patterns (overrides language-specific defaults)
	 */
	setCustomPatterns(patterns: TestPattern): void {
		this.customPatterns = patterns;
	}

	/**
	 * Clear custom patterns (revert to language-specific defaults)
	 */
	clearCustomPatterns(): void {
		this.customPatterns = null;
	}

	/**
	 * Detect the language from file path
	 */
	detectLanguage(filePath: string): SupportedLanguage | null {
		const ext = this.getExtension(filePath);
		return EXTENSION_TO_LANGUAGE[ext] || null;
	}

	/**
	 * Check if a file path is a test file
	 */
	isTestFile(filePath: string): boolean {
		const lowerPath = filePath.toLowerCase();

		// Use custom patterns if set
		if (this.customPatterns) {
			return this.matchesPatterns(lowerPath, this.customPatterns);
		}

		// Detect language and use language-specific patterns
		const language = this.detectLanguage(filePath);
		if (language) {
			const patterns = TEST_PATTERNS[language];
			return this.matchesPatterns(lowerPath, patterns);
		}

		// Fallback: generic test patterns
		return this.matchesGenericPatterns(lowerPath);
	}

	/**
	 * Check if a symbol name is a test function/method
	 */
	isTestSymbol(symbolName: string, filePath?: string): boolean {
		// If file is a test file, all symbols are "test-related"
		if (filePath && this.isTestFile(filePath)) {
			return true;
		}

		// Use custom patterns if set
		if (this.customPatterns?.symbolPatterns) {
			return this.customPatterns.symbolPatterns.some((p) => p.test(symbolName));
		}

		// Detect language from file and use language-specific patterns
		if (filePath) {
			const language = this.detectLanguage(filePath);
			if (language) {
				const patterns = TEST_PATTERNS[language].symbolPatterns;
				if (patterns) {
					return patterns.some((p) => p.test(symbolName));
				}
			}
		}

		// Fallback: generic test symbol patterns
		return /^test_/i.test(symbolName) || /^Test[A-Z]/.test(symbolName);
	}

	/**
	 * Get all supported test patterns for a language
	 */
	getPatternsForLanguage(language: SupportedLanguage): TestPattern {
		return TEST_PATTERNS[language];
	}

	/**
	 * Get all supported languages
	 */
	getSupportedLanguages(): SupportedLanguage[] {
		return Object.keys(TEST_PATTERNS) as SupportedLanguage[];
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	private getExtension(filePath: string): string {
		const match = filePath.match(/\.[^./\\]+$/);
		return match ? match[0].toLowerCase() : "";
	}

	private matchesPatterns(filePath: string, patterns: TestPattern): boolean {
		// Check file patterns
		for (const pattern of patterns.filePatterns) {
			if (pattern.test(filePath)) {
				return true;
			}
		}

		// Check directory patterns
		for (const pattern of patterns.dirPatterns) {
			if (pattern.test(filePath)) {
				return true;
			}
		}

		return false;
	}

	private matchesGenericPatterns(filePath: string): boolean {
		// Generic patterns that work across languages
		const genericPatterns = [
			/\.test\./,
			/\.spec\./,
			/_test\./,
			/_spec\./,
			/\/test\//,
			/\/tests\//,
			/__tests__\//,
		];

		return genericPatterns.some((p) => p.test(filePath));
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a test file detector instance
 */
export function createTestFileDetector(): TestFileDetector {
	return new TestFileDetector();
}
