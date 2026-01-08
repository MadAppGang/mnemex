/**
 * NPM registry client for fetching package information
 */

export interface RegistryPackageInfo {
	name: string;
	version: string;
	publishedAt?: string;
}

/**
 * Fetch latest version from npm registry
 * @param packageName Package name (e.g., "claude-codemem")
 * @param timeout Timeout in milliseconds (default: 5000)
 */
export async function fetchLatestVersion(
	packageName: string,
	timeout = 5000,
): Promise<RegistryPackageInfo> {
	const url = `https://registry.npmjs.org/${packageName}/latest`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, { signal: controller.signal });

		if (!response.ok) {
			throw new Error(`Registry returned ${response.status}`);
		}

		const data = await response.json();

		return {
			name: data.name,
			version: data.version,
			publishedAt: data.time?.[data.version],
		};
	} finally {
		clearTimeout(timeoutId);
	}
}
