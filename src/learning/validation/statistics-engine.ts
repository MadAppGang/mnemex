/**
 * Statistics Engine
 *
 * Statistical analysis for A/B experiments including power analysis,
 * hypothesis testing, and effect size calculations.
 *
 * @module learning/validation/statistics-engine
 */

import type {
  StatisticalConfig,
  StatisticalComparison,
  MetricComparison,
  PowerAnalysisConfig,
  SessionMetrics,
  RecordedSession,
} from "./types.js";

// ============================================================================
// Statistics Engine
// ============================================================================

/**
 * Performs statistical analysis for validation experiments.
 */
export class StatisticsEngine {
  private config: StatisticalConfig;

  constructor(config: Partial<StatisticalConfig> = {}) {
    this.config = {
      alpha: config.alpha ?? 0.05,
      power: config.power ?? 0.80,
      minEffectSize: config.minEffectSize ?? 0.05,
      confidenceLevel: config.confidenceLevel ?? 0.95,
      multipleTestingCorrection: config.multipleTestingCorrection ?? "bonferroni",
    };
  }

  // ============================================================================
  // Power Analysis
  // ============================================================================

  /**
   * Calculate required sample size for desired statistical power
   */
  calculateRequiredSampleSize(config: PowerAnalysisConfig): number {
    const { alpha, power, minEffectSize, baselineRate } = config;

    // Using formula for two-proportion z-test
    // n = 2 * ((z_alpha + z_beta) / effect_size)^2 * p * (1-p)
    const zAlpha = this.zScore(1 - alpha / 2);
    const zBeta = this.zScore(power);

    const p = baselineRate;
    const pooledVariance = p * (1 - p);

    const n = Math.ceil(
      (2 * Math.pow(zAlpha + zBeta, 2) * pooledVariance) /
        Math.pow(minEffectSize, 2)
    );

    return Math.max(n, 20); // Minimum 20 samples per group
  }

  /**
   * Calculate achieved power given sample size
   */
  calculateAchievedPower(
    sampleSize: number,
    effectSize: number,
    baselineRate: number
  ): number {
    const zAlpha = this.zScore(1 - this.config.alpha / 2);
    const pooledVariance = baselineRate * (1 - baselineRate);

    // Solve for z_beta from sample size formula
    const standardError = Math.sqrt((2 * pooledVariance) / sampleSize);
    const zBeta = (effectSize / standardError) - zAlpha;

    // Convert z_beta to power
    return this.normalCdf(zBeta);
  }

  // ============================================================================
  // Hypothesis Testing
  // ============================================================================

  /**
   * Compare baseline vs treatment metrics
   */
  compareMetrics(
    baselineSessions: RecordedSession[],
    treatmentSessions: RecordedSession[]
  ): StatisticalComparison {
    const numTests = 4; // Number of metrics being tested

    const correctionRate = this.compareProportions(
      baselineSessions.map((s) => s.metrics.correctionRate),
      treatmentSessions.map((s) => s.metrics.correctionRate),
      "lower", // Lower is better
      numTests
    );

    const successRate = this.compareProportions(
      baselineSessions.map((s) => (s.outcome === "success" ? 1 : 0)),
      treatmentSessions.map((s) => (s.outcome === "success" ? 1 : 0)),
      "higher", // Higher is better
      numTests
    );

    const autonomyRate = this.compareProportions(
      baselineSessions.map((s) => s.metrics.autonomyRate),
      treatmentSessions.map((s) => s.metrics.autonomyRate),
      "higher", // Higher is better
      numTests
    );

    const errorRate = this.compareProportions(
      baselineSessions.map((s) => s.metrics.errorRate),
      treatmentSessions.map((s) => s.metrics.errorRate),
      "lower", // Lower is better
      numTests
    );

    // Overall improvement requires no significant regressions
    // and at least one significant improvement
    const hasRegression =
      (correctionRate.statisticallySignificant && !correctionRate.improved) ||
      (successRate.statisticallySignificant && !successRate.improved) ||
      (autonomyRate.statisticallySignificant && !autonomyRate.improved) ||
      (errorRate.statisticallySignificant && !errorRate.improved);

    const hasImprovement =
      (correctionRate.statisticallySignificant && correctionRate.improved) ||
      (successRate.statisticallySignificant && successRate.improved) ||
      (autonomyRate.statisticallySignificant && autonomyRate.improved) ||
      (errorRate.statisticallySignificant && errorRate.improved);

    return {
      correctionRate,
      successRate,
      autonomyRate,
      errorRate,
      overallImproved: hasImprovement && !hasRegression,
    };
  }

  /**
   * Compare two proportions using z-test
   */
  compareProportions(
    baseline: number[],
    treatment: number[],
    direction: "higher" | "lower",
    numTests: number = 1
  ): MetricComparison {
    const baselineMean = this.mean(baseline);
    const treatmentMean = this.mean(treatment);

    const baselineN = baseline.length;
    const treatmentN = treatment.length;

    // Pooled proportion for variance estimate
    const pooledMean =
      (baselineMean * baselineN + treatmentMean * treatmentN) /
      (baselineN + treatmentN);

    // Standard error of difference
    const se = Math.sqrt(
      pooledMean * (1 - pooledMean) * (1 / baselineN + 1 / treatmentN)
    );

    // Z-statistic
    const z = se > 0 ? (treatmentMean - baselineMean) / se : 0;

    // Two-tailed p-value
    const pValue = 2 * (1 - this.normalCdf(Math.abs(z)));

    // Apply multiple testing correction
    const adjustedAlpha = this.adjustAlpha(this.config.alpha, numTests);

    // Confidence interval for difference
    const zCritical = this.zScore(1 - this.config.alpha / 2);
    const marginOfError = zCritical * se;
    const difference = treatmentMean - baselineMean;

    const confidenceInterval: [number, number] = [
      difference - marginOfError,
      difference + marginOfError,
    ];

    // Relative change
    const relativeChange =
      baselineMean !== 0 ? (treatmentMean - baselineMean) / baselineMean : 0;

    // Statistical significance
    const statisticallySignificant = pValue < adjustedAlpha;

    // Practical significance (effect size > minimum threshold)
    const effectSize = Math.abs(relativeChange);
    const practicallySignificant = effectSize >= this.config.minEffectSize;

    // Direction check
    const improved =
      direction === "higher"
        ? treatmentMean > baselineMean
        : treatmentMean < baselineMean;

    return {
      baseline: baselineMean,
      treatment: treatmentMean,
      relativeChange,
      pValue,
      confidenceInterval,
      statisticallySignificant,
      practicallySignificant,
      improved,
    };
  }

  // ============================================================================
  // Multiple Testing Correction
  // ============================================================================

  /**
   * Adjust alpha for multiple testing
   */
  adjustAlpha(alpha: number, numTests: number): number {
    switch (this.config.multipleTestingCorrection) {
      case "bonferroni":
        return alpha / numTests;
      case "fdr":
        // Benjamini-Hochberg: use alpha directly, adjust p-values instead
        return alpha;
      case "none":
        return alpha;
    }
  }

  /**
   * Apply FDR correction to p-values
   */
  fdrCorrection(pValues: number[]): number[] {
    const n = pValues.length;
    const indexed = pValues.map((p, i) => ({ p, i }));
    indexed.sort((a, b) => a.p - b.p);

    const adjusted: number[] = new Array(n);
    let minSoFar = 1;

    for (let rank = n; rank >= 1; rank--) {
      const { p, i } = indexed[rank - 1];
      const adjustedP = Math.min((p * n) / rank, minSoFar);
      minSoFar = adjustedP;
      adjusted[i] = Math.min(adjustedP, 1);
    }

    return adjusted;
  }

  // ============================================================================
  // Effect Size Calculations
  // ============================================================================

  /**
   * Calculate Cohen's d effect size
   */
  cohensD(group1: number[], group2: number[]): number {
    const mean1 = this.mean(group1);
    const mean2 = this.mean(group2);
    const pooledStd = this.pooledStandardDeviation(group1, group2);

    return pooledStd > 0 ? (mean2 - mean1) / pooledStd : 0;
  }

  /**
   * Interpret Cohen's d effect size
   */
  interpretEffectSize(d: number): EffectSizeInterpretation {
    const absD = Math.abs(d);
    if (absD < 0.2) return { magnitude: "negligible", description: "Very small effect" };
    if (absD < 0.5) return { magnitude: "small", description: "Small effect" };
    if (absD < 0.8) return { magnitude: "medium", description: "Medium effect" };
    return { magnitude: "large", description: "Large effect" };
  }

  // ============================================================================
  // Bootstrap Confidence Intervals
  // ============================================================================

  /**
   * Calculate bootstrap confidence interval for a statistic
   */
  bootstrapConfidenceInterval(
    data: number[],
    statistic: (sample: number[]) => number,
    numBootstraps: number = 1000
  ): [number, number] {
    const bootstrapStats: number[] = [];

    for (let i = 0; i < numBootstraps; i++) {
      const sample = this.resample(data);
      bootstrapStats.push(statistic(sample));
    }

    bootstrapStats.sort((a, b) => a - b);

    const alphaHalf = (1 - this.config.confidenceLevel) / 2;
    const lowerIndex = Math.floor(alphaHalf * numBootstraps);
    const upperIndex = Math.floor((1 - alphaHalf) * numBootstraps);

    return [bootstrapStats[lowerIndex], bootstrapStats[upperIndex]];
  }

  /**
   * Resample with replacement
   */
  private resample(data: number[]): number[] {
    const n = data.length;
    const sample: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      sample[i] = data[Math.floor(Math.random() * n)];
    }
    return sample;
  }

  // ============================================================================
  // Utility Functions
  // ============================================================================

  private mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  private variance(values: number[]): number {
    if (values.length <= 1) return 0;
    const m = this.mean(values);
    return values.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / (values.length - 1);
  }

  private standardDeviation(values: number[]): number {
    return Math.sqrt(this.variance(values));
  }

  private pooledStandardDeviation(group1: number[], group2: number[]): number {
    const n1 = group1.length;
    const n2 = group2.length;
    const var1 = this.variance(group1);
    const var2 = this.variance(group2);

    return Math.sqrt(
      ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2)
    );
  }

  /**
   * Standard normal CDF approximation
   */
  private normalCdf(x: number): number {
    // Approximation using error function
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y =
      1.0 -
      ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Inverse standard normal (z-score for given probability)
   */
  private zScore(p: number): number {
    // Approximation using rational function
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;

    if (p < 0.5) {
      return -this.zScore(1 - p);
    }

    const t = Math.sqrt(-2 * Math.log(1 - p));
    const c0 = 2.515517;
    const c1 = 0.802853;
    const c2 = 0.010328;
    const d1 = 1.432788;
    const d2 = 0.189269;
    const d3 = 0.001308;

    return t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);
  }

  // ============================================================================
  // Accessors
  // ============================================================================

  getConfig(): StatisticalConfig {
    return { ...this.config };
  }
}

// ============================================================================
// Supporting Types
// ============================================================================

export interface EffectSizeInterpretation {
  magnitude: "negligible" | "small" | "medium" | "large";
  description: string;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a statistics engine with default configuration
 */
export function createStatisticsEngine(
  config?: Partial<StatisticalConfig>
): StatisticsEngine {
  return new StatisticsEngine(config);
}
