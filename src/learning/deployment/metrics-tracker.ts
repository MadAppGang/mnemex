/**
 * MetricsTracker - Track improvement impact over time.
 *
 * Collects and aggregates metrics to measure:
 * - Correction rate trends
 * - Error rate trends
 * - Autonomy improvements
 * - Pattern recurrence
 *
 * Supports:
 * - Time-series storage
 * - Aggregation windows (hourly, daily, weekly)
 * - Comparison between periods
 * - Anomaly detection
 */

import type { Improvement } from "../interaction/types.js";

// ============================================================================
// Types
// ============================================================================

export interface MetricsTrackerConfig {
	/** Aggregation window in ms */
	aggregationWindowMs: number;
	/** Maximum data points to retain */
	maxDataPoints: number;
	/** Anomaly detection sensitivity (z-score threshold) */
	anomalyThreshold: number;
}

export const DEFAULT_METRICS_CONFIG: MetricsTrackerConfig = {
	aggregationWindowMs: 60 * 60 * 1000, // 1 hour
	maxDataPoints: 720, // 30 days at hourly
	anomalyThreshold: 2.5,
};

export interface MetricDataPoint {
	/** Timestamp (start of window) */
	timestamp: number;
	/** Metric value */
	value: number;
	/** Sample count for this window */
	sampleCount: number;
	/** Associated improvement IDs (if tracking specific improvements) */
	improvementIds?: string[];
}

export interface MetricSeries {
	/** Metric name */
	name: string;
	/** Metric description */
	description: string;
	/** Unit of measurement */
	unit: "rate" | "count" | "duration" | "percentage";
	/** Data points (sorted by timestamp) */
	dataPoints: MetricDataPoint[];
	/** Current value (most recent) */
	currentValue: number;
	/** Baseline value (historical average) */
	baselineValue: number;
	/** Trend direction */
	trend: "improving" | "stable" | "degrading";
}

export interface MetricsSnapshot {
	/** Timestamp of snapshot */
	timestamp: number;
	/** Core metrics */
	correctionRate: number;
	errorRate: number;
	autonomyRate: number;
	avgSessionDuration: number;
	/** Improvement-specific metrics */
	improvementMetrics: Map<string, ImprovementMetrics>;
	/** Detected anomalies */
	anomalies: MetricAnomaly[];
}

export interface ImprovementMetrics {
	/** Improvement ID */
	improvementId: string;
	/** Improvement name */
	name: string;
	/** Sessions affected */
	sessionsAffected: number;
	/** Corrections prevented (estimated) */
	correctionsPrevented: number;
	/** Errors prevented (estimated) */
	errorsPrevented: number;
	/** Time saved (estimated, ms) */
	timeSavedMs: number;
}

export interface MetricAnomaly {
	/** Metric name */
	metricName: string;
	/** Anomaly type */
	type: "spike" | "drop" | "trend_change";
	/** Severity (z-score) */
	severity: number;
	/** Expected value */
	expected: number;
	/** Actual value */
	actual: number;
	/** When detected */
	detectedAt: number;
	/** Possible cause */
	possibleCause?: string;
}

export interface TrendAnalysis {
	/** Overall trend direction */
	direction: "improving" | "stable" | "degrading";
	/** Confidence in trend (0-1) */
	confidence: number;
	/** Slope of trend line */
	slope: number;
	/** Change percentage over period */
	changePercent: number;
	/** Projected value at end of next period */
	projectedValue: number;
}

// ============================================================================
// MetricsTracker Class
// ============================================================================

export class MetricsTracker {
	private config: MetricsTrackerConfig;
	private series: Map<string, MetricSeries>;
	private improvementMetrics: Map<string, ImprovementMetrics>;
	private anomalies: MetricAnomaly[];

	constructor(config: Partial<MetricsTrackerConfig> = {}) {
		this.config = { ...DEFAULT_METRICS_CONFIG, ...config };
		this.series = new Map();
		this.improvementMetrics = new Map();
		this.anomalies = [];

		// Initialize core metrics
		this.initializeSeries(
			"correction_rate",
			"User corrections per session",
			"rate",
		);
		this.initializeSeries("error_rate", "Tool errors per session", "rate");
		this.initializeSeries(
			"autonomy_rate",
			"Autonomous completions rate",
			"percentage",
		);
		this.initializeSeries(
			"session_duration",
			"Average session duration",
			"duration",
		);
	}

	/**
	 * Record a metric value.
	 */
	record(metricName: string, value: number, improvementIds?: string[]): void {
		let series = this.series.get(metricName);
		if (!series) {
			series = this.initializeSeries(metricName, metricName, "count");
		}

		const windowStart = this.getWindowStart(Date.now());
		const lastPoint = series.dataPoints[series.dataPoints.length - 1];

		if (lastPoint && lastPoint.timestamp === windowStart) {
			// Update existing window (incremental average)
			const totalValue = lastPoint.value * lastPoint.sampleCount + value;
			lastPoint.sampleCount += 1;
			lastPoint.value = totalValue / lastPoint.sampleCount;
			if (improvementIds) {
				lastPoint.improvementIds = [
					...new Set([...(lastPoint.improvementIds ?? []), ...improvementIds]),
				];
			}
		} else {
			// New window
			series.dataPoints.push({
				timestamp: windowStart,
				value,
				sampleCount: 1,
				improvementIds,
			});

			// Enforce max data points
			while (series.dataPoints.length > this.config.maxDataPoints) {
				series.dataPoints.shift();
			}
		}

		// Update current value
		series.currentValue = value;

		// Check for anomalies
		this.checkForAnomaly(series, value);

		// Update trend
		this.updateTrend(series);
	}

	/**
	 * Record session metrics.
	 */
	recordSession(
		corrections: number,
		errors: number,
		autonomous: boolean,
		durationMs: number,
		improvementIds?: string[],
	): void {
		// Record individual metrics
		this.record("correction_rate", corrections, improvementIds);
		this.record("error_rate", errors, improvementIds);
		this.record("autonomy_rate", autonomous ? 1 : 0, improvementIds);
		this.record("session_duration", durationMs, improvementIds);

		// Update improvement-specific metrics
		for (const improvementId of improvementIds ?? []) {
			this.updateImprovementMetrics(
				improvementId,
				corrections,
				errors,
				autonomous,
				durationMs,
			);
		}
	}

	/**
	 * Record improvement deployment.
	 */
	recordImprovementDeployment(improvement: Improvement): void {
		if (!this.improvementMetrics.has(improvement.improvementId)) {
			this.improvementMetrics.set(improvement.improvementId, {
				improvementId: improvement.improvementId,
				name: improvement.improvementData.name,
				sessionsAffected: 0,
				correctionsPrevented: 0,
				errorsPrevented: 0,
				timeSavedMs: 0,
			});
		}
	}

	/**
	 * Get current snapshot of all metrics.
	 */
	getSnapshot(): MetricsSnapshot {
		return {
			timestamp: Date.now(),
			correctionRate: this.getSeriesValue("correction_rate"),
			errorRate: this.getSeriesValue("error_rate"),
			autonomyRate: this.getSeriesValue("autonomy_rate"),
			avgSessionDuration: this.getSeriesValue("session_duration"),
			improvementMetrics: new Map(this.improvementMetrics),
			anomalies: [...this.anomalies],
		};
	}

	/**
	 * Get a specific metric series.
	 */
	getSeries(metricName: string): MetricSeries | undefined {
		return this.series.get(metricName);
	}

	/**
	 * Get all series.
	 */
	getAllSeries(): MetricSeries[] {
		return Array.from(this.series.values());
	}

	/**
	 * Get recent anomalies.
	 */
	getAnomalies(since?: number): MetricAnomaly[] {
		if (since) {
			return this.anomalies.filter((a) => a.detectedAt >= since);
		}
		return [...this.anomalies];
	}

	/**
	 * Analyze trend for a metric.
	 */
	analyzeTrend(metricName: string, windowCount: number = 7): TrendAnalysis {
		const series = this.series.get(metricName);
		if (!series || series.dataPoints.length < 2) {
			return {
				direction: "stable",
				confidence: 0,
				slope: 0,
				changePercent: 0,
				projectedValue: series?.currentValue ?? 0,
			};
		}

		// Get recent data points
		const recentPoints = series.dataPoints.slice(-windowCount);
		if (recentPoints.length < 2) {
			return {
				direction: "stable",
				confidence: 0,
				slope: 0,
				changePercent: 0,
				projectedValue: series.currentValue,
			};
		}

		// Linear regression
		const { slope, r2 } = this.linearRegression(
			recentPoints.map((p, i) => [i, p.value]),
		);

		// Calculate change
		const firstValue = recentPoints[0].value;
		const lastValue = recentPoints[recentPoints.length - 1].value;
		const changePercent =
			firstValue !== 0 ? (lastValue - firstValue) / firstValue : 0;

		// Determine direction (for correction/error rates, negative slope = improving)
		const isNegativeGood =
			metricName.includes("correction") || metricName.includes("error");
		let direction: TrendAnalysis["direction"];

		if (Math.abs(slope) < 0.01) {
			direction = "stable";
		} else if (isNegativeGood) {
			direction = slope < 0 ? "improving" : "degrading";
		} else {
			direction = slope > 0 ? "improving" : "degrading";
		}

		// Project next value
		const projectedValue = lastValue + slope;

		return {
			direction,
			confidence: r2,
			slope,
			changePercent,
			projectedValue: Math.max(0, projectedValue),
		};
	}

	/**
	 * Compare metrics between two periods.
	 */
	comparePeriods(
		metricName: string,
		period1Start: number,
		period1End: number,
		period2Start: number,
		period2End: number,
	): {
		period1Avg: number;
		period2Avg: number;
		change: number;
		changePercent: number;
	} {
		const series = this.series.get(metricName);
		if (!series) {
			return { period1Avg: 0, period2Avg: 0, change: 0, changePercent: 0 };
		}

		const period1Points = series.dataPoints.filter(
			(p) => p.timestamp >= period1Start && p.timestamp <= period1End,
		);
		const period2Points = series.dataPoints.filter(
			(p) => p.timestamp >= period2Start && p.timestamp <= period2End,
		);

		const period1Avg =
			period1Points.length > 0
				? period1Points.reduce((sum, p) => sum + p.value, 0) /
					period1Points.length
				: 0;
		const period2Avg =
			period2Points.length > 0
				? period2Points.reduce((sum, p) => sum + p.value, 0) /
					period2Points.length
				: 0;

		const change = period2Avg - period1Avg;
		const changePercent = period1Avg !== 0 ? change / period1Avg : 0;

		return { period1Avg, period2Avg, change, changePercent };
	}

	/**
	 * Get improvement impact summary.
	 */
	getImprovementImpact(improvementId: string): ImprovementMetrics | undefined {
		return this.improvementMetrics.get(improvementId);
	}

	/**
	 * Export all metrics data.
	 */
	export(): {
		series: Array<{ name: string; dataPoints: MetricDataPoint[] }>;
		improvements: ImprovementMetrics[];
		anomalies: MetricAnomaly[];
	} {
		return {
			series: Array.from(this.series.entries()).map(([name, s]) => ({
				name,
				dataPoints: s.dataPoints,
			})),
			improvements: Array.from(this.improvementMetrics.values()),
			anomalies: this.anomalies,
		};
	}

	/**
	 * Import metrics data.
	 */
	import(data: {
		series: Array<{ name: string; dataPoints: MetricDataPoint[] }>;
		improvements: ImprovementMetrics[];
		anomalies: MetricAnomaly[];
	}): void {
		for (const { name, dataPoints } of data.series) {
			const series = this.series.get(name);
			if (series) {
				series.dataPoints = dataPoints;
				if (dataPoints.length > 0) {
					series.currentValue = dataPoints[dataPoints.length - 1].value;
				}
			}
		}

		for (const imp of data.improvements) {
			this.improvementMetrics.set(imp.improvementId, imp);
		}

		this.anomalies = data.anomalies;
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Initialize a metric series.
	 */
	private initializeSeries(
		name: string,
		description: string,
		unit: MetricSeries["unit"],
	): MetricSeries {
		const series: MetricSeries = {
			name,
			description,
			unit,
			dataPoints: [],
			currentValue: 0,
			baselineValue: 0,
			trend: "stable",
		};
		this.series.set(name, series);
		return series;
	}

	/**
	 * Get window start timestamp.
	 */
	private getWindowStart(timestamp: number): number {
		return (
			Math.floor(timestamp / this.config.aggregationWindowMs) *
			this.config.aggregationWindowMs
		);
	}

	/**
	 * Get current value for a series.
	 */
	private getSeriesValue(name: string): number {
		return this.series.get(name)?.currentValue ?? 0;
	}

	/**
	 * Update improvement-specific metrics.
	 */
	private updateImprovementMetrics(
		improvementId: string,
		corrections: number,
		errors: number,
		autonomous: boolean,
		durationMs: number,
	): void {
		let metrics = this.improvementMetrics.get(improvementId);
		if (!metrics) {
			metrics = {
				improvementId,
				name: improvementId,
				sessionsAffected: 0,
				correctionsPrevented: 0,
				errorsPrevented: 0,
				timeSavedMs: 0,
			};
			this.improvementMetrics.set(improvementId, metrics);
		}

		metrics.sessionsAffected += 1;

		// Estimate prevented issues (compared to baseline)
		const correctionBaseline =
			this.series.get("correction_rate")?.baselineValue ?? 1;
		const errorBaseline = this.series.get("error_rate")?.baselineValue ?? 1;

		if (corrections < correctionBaseline) {
			metrics.correctionsPrevented += correctionBaseline - corrections;
		}
		if (errors < errorBaseline) {
			metrics.errorsPrevented += errorBaseline - errors;
		}

		// Estimate time saved (assume autonomous = 50% faster)
		if (autonomous) {
			const avgDuration =
				this.series.get("session_duration")?.baselineValue ?? durationMs;
			metrics.timeSavedMs += avgDuration * 0.5;
		}
	}

	/**
	 * Check for anomalies in metric value.
	 */
	private checkForAnomaly(series: MetricSeries, value: number): void {
		if (series.dataPoints.length < 10) {
			return; // Not enough data for anomaly detection
		}

		// Calculate mean and standard deviation
		const values = series.dataPoints.slice(-30).map((p) => p.value);
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const variance =
			values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
		const stdDev = Math.sqrt(variance);

		if (stdDev === 0) return;

		// Calculate z-score
		const zScore = (value - mean) / stdDev;

		if (Math.abs(zScore) > this.config.anomalyThreshold) {
			const anomaly: MetricAnomaly = {
				metricName: series.name,
				type: zScore > 0 ? "spike" : "drop",
				severity: Math.abs(zScore),
				expected: mean,
				actual: value,
				detectedAt: Date.now(),
			};

			this.anomalies.push(anomaly);

			// Keep only recent anomalies
			const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
			this.anomalies = this.anomalies.filter((a) => a.detectedAt > oneWeekAgo);
		}
	}

	/**
	 * Update trend for series.
	 */
	private updateTrend(series: MetricSeries): void {
		const analysis = this.analyzeTrend(series.name);
		series.trend = analysis.direction;

		// Update baseline (rolling average of older data)
		const baselinePoints = series.dataPoints.slice(0, -7);
		if (baselinePoints.length > 0) {
			series.baselineValue =
				baselinePoints.reduce((sum, p) => sum + p.value, 0) /
				baselinePoints.length;
		}
	}

	/**
	 * Simple linear regression.
	 */
	private linearRegression(points: Array<[number, number]>): {
		slope: number;
		intercept: number;
		r2: number;
	} {
		const n = points.length;
		if (n < 2) {
			return { slope: 0, intercept: 0, r2: 0 };
		}

		let sumX = 0,
			sumY = 0,
			sumXY = 0,
			sumX2 = 0,
			sumY2 = 0;

		for (const [x, y] of points) {
			sumX += x;
			sumY += y;
			sumXY += x * y;
			sumX2 += x * x;
			sumY2 += y * y;
		}

		const denominator = n * sumX2 - sumX * sumX;
		if (denominator === 0) {
			return { slope: 0, intercept: sumY / n, r2: 0 };
		}

		const slope = (n * sumXY - sumX * sumY) / denominator;
		const intercept = (sumY - slope * sumX) / n;

		// R-squared
		const yMean = sumY / n;
		const ssTotal = sumY2 - n * yMean * yMean;
		const ssResidual = points.reduce((sum, [x, y]) => {
			const predicted = slope * x + intercept;
			return sum + (y - predicted) ** 2;
		}, 0);

		const r2 = ssTotal !== 0 ? 1 - ssResidual / ssTotal : 0;

		return { slope, intercept, r2: Math.max(0, r2) };
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a metrics tracker with optional configuration.
 */
export function createMetricsTracker(
	config: Partial<MetricsTrackerConfig> = {},
): MetricsTracker {
	return new MetricsTracker(config);
}
