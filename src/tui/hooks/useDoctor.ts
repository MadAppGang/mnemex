/**
 * useDoctor Hook
 *
 * Manages doctor diagnostics state for context file analysis.
 */

import { useState, useCallback, useEffect } from "react";
import {
	scanForContextFiles,
	analyzeContextFile,
} from "../../core/doctor/index.js";
import type {
	ContextFileDiagnosis,
	ContextFile,
} from "../../core/doctor/types.js";

// ============================================================================
// Types
// ============================================================================

export interface DoctorDiagnostics {
	files: ContextFile[];
	diagnoses: ContextFileDiagnosis[];
	overallHealth: number;
}

export interface UseDoctorReturn {
	diagnostics: DoctorDiagnostics | null;
	loading: boolean;
	error: string | null;
	selectedFile: string | null;
	setSelectedFile: (path: string | null) => void;
	refresh: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useDoctor(projectPath: string): UseDoctorReturn {
	const [diagnostics, setDiagnostics] = useState<DoctorDiagnostics | null>(
		null,
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [refreshTick, setRefreshTick] = useState(0);

	const loadDiagnostics = useCallback(async () => {
		setLoading(true);
		setError(null);

		try {
			const files = scanForContextFiles(projectPath);

			const diagnoses: ContextFileDiagnosis[] = files.map((file) =>
				analyzeContextFile(file, null, projectPath),
			);

			const overallHealth =
				diagnoses.length > 0
					? diagnoses.reduce((sum, d) => sum + d.overallScore, 0) /
						diagnoses.length
					: 0;

			setDiagnostics({
				files,
				diagnoses,
				overallHealth,
			});

			// Auto-select first file
			if (!selectedFile && files.length > 0) {
				setSelectedFile(files[0]?.path ?? null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projectPath, refreshTick]);

	useEffect(() => {
		loadDiagnostics();
	}, [loadDiagnostics]);

	const refresh = useCallback(() => {
		setRefreshTick((n: number) => n + 1);
	}, []);

	return {
		diagnostics,
		loading,
		error,
		selectedFile,
		setSelectedFile,
		refresh,
	};
}
