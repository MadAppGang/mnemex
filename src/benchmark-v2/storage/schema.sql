-- Benchmark V2 SQLite Schema
-- Provides resumable benchmark runs with full state persistence

-- ============================================================================
-- Benchmark Runs Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS benchmark_runs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    config_json TEXT NOT NULL,
    codebase_info_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'paused')),
    current_phase TEXT
        CHECK (current_phase IS NULL OR current_phase IN (
            'extraction', 'generation',
            'evaluation:iterative', 'evaluation:judge', 'evaluation:contrastive',
            'evaluation:retrieval', 'evaluation:downstream',
            'evaluation:self', 'aggregation', 'reporting'
        )),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    paused_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs(status);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_created_at ON benchmark_runs(created_at);

-- ============================================================================
-- Code Units Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS code_units (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL
        CHECK (type IN ('function', 'class', 'method', 'file', 'module')),
    language TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    relationships_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_code_units_run_id ON code_units(run_id);
CREATE INDEX IF NOT EXISTS idx_code_units_type ON code_units(type);
CREATE INDEX IF NOT EXISTS idx_code_units_language ON code_units(language);
CREATE INDEX IF NOT EXISTS idx_code_units_path ON code_units(path);

-- ============================================================================
-- Generated Summaries Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS generated_summaries (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    code_unit_id TEXT NOT NULL REFERENCES code_units(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    generation_metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_summaries_run_id ON generated_summaries(run_id);
CREATE INDEX IF NOT EXISTS idx_summaries_code_unit_id ON generated_summaries(code_unit_id);
CREATE INDEX IF NOT EXISTS idx_summaries_model_id ON generated_summaries(model_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_unique
    ON generated_summaries(run_id, code_unit_id, model_id);

-- ============================================================================
-- Evaluation Results Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS evaluation_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    summary_id TEXT NOT NULL REFERENCES generated_summaries(id) ON DELETE CASCADE,
    evaluation_type TEXT NOT NULL
        CHECK (evaluation_type IN ('iterative', 'judge', 'contrastive', 'retrieval', 'downstream', 'self')),
    results_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL DEFAULT (datetime('now')),
    embedding_model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run_id ON evaluation_results(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_summary_id ON evaluation_results(summary_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_type ON evaluation_results(evaluation_type);

-- ============================================================================
-- Pairwise Comparisons Table (for Judge Evaluation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pairwise_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    model_a TEXT NOT NULL,
    model_b TEXT NOT NULL,
    code_unit_id TEXT NOT NULL REFERENCES code_units(id) ON DELETE CASCADE,
    judge_model TEXT NOT NULL,
    winner TEXT NOT NULL CHECK (winner IN ('A', 'B', 'tie')),
    confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
    position_swapped INTEGER NOT NULL DEFAULT 0,
    reasoning TEXT,
    criteria_breakdown_json TEXT,
    cost REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pairwise_run_id ON pairwise_results(run_id);
CREATE INDEX IF NOT EXISTS idx_pairwise_models ON pairwise_results(model_a, model_b);
CREATE INDEX IF NOT EXISTS idx_pairwise_code_unit ON pairwise_results(code_unit_id);
CREATE INDEX IF NOT EXISTS idx_pairwise_judge ON pairwise_results(judge_model);

-- ============================================================================
-- Generated Queries Table (for Retrieval Evaluation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS generated_queries (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    code_unit_id TEXT NOT NULL REFERENCES code_units(id) ON DELETE CASCADE,
    type TEXT NOT NULL
        CHECK (type IN ('vague', 'wrong_terminology', 'specific_behavior', 'integration', 'problem_based', 'doc_conceptual', 'doc_api_lookup', 'doc_best_practice')),
    query TEXT NOT NULL,
    should_find INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_queries_run_id ON generated_queries(run_id);
CREATE INDEX IF NOT EXISTS idx_queries_code_unit_id ON generated_queries(code_unit_id);
CREATE INDEX IF NOT EXISTS idx_queries_type ON generated_queries(type);

-- ============================================================================
-- Distractor Sets Table (for Contrastive Evaluation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS distractor_sets (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    target_code_unit_id TEXT NOT NULL REFERENCES code_units(id) ON DELETE CASCADE,
    distractor_ids_json TEXT NOT NULL,
    difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_distractors_run_id ON distractor_sets(run_id);
CREATE INDEX IF NOT EXISTS idx_distractors_target ON distractor_sets(target_code_unit_id);

-- ============================================================================
-- Downstream Tasks Tables
-- ============================================================================

-- Completion Tasks
CREATE TABLE IF NOT EXISTS completion_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    code_unit_id TEXT NOT NULL REFERENCES code_units(id) ON DELETE CASCADE,
    partial_code TEXT NOT NULL,
    full_code TEXT NOT NULL,
    requirements TEXT NOT NULL,
    language TEXT NOT NULL,
    relevant_summary_ids_json TEXT NOT NULL,
    test_cases_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_completion_run_id ON completion_tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_completion_code_unit ON completion_tasks(code_unit_id);

-- Bug Localization Tasks
CREATE TABLE IF NOT EXISTS bug_localization_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    bug_description TEXT NOT NULL,
    actual_buggy_file TEXT NOT NULL,
    candidate_files_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bug_loc_run_id ON bug_localization_tasks(run_id);

-- Function Selection Tasks
CREATE TABLE IF NOT EXISTS function_selection_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    task_description TEXT NOT NULL,
    correct_function TEXT NOT NULL,
    candidate_functions_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_func_select_run_id ON function_selection_tasks(run_id);

-- ============================================================================
-- Aggregated Scores Table (cached results)
-- ============================================================================

CREATE TABLE IF NOT EXISTS aggregated_scores (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    scores_json TEXT NOT NULL,
    computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agg_scores_run_id ON aggregated_scores(run_id);
CREATE INDEX IF NOT EXISTS idx_agg_scores_model_id ON aggregated_scores(model_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agg_scores_unique
    ON aggregated_scores(run_id, model_id);

-- ============================================================================
-- Phase Progress Table (for resumability)
-- ============================================================================

CREATE TABLE IF NOT EXISTS phase_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    items_total INTEGER NOT NULL DEFAULT 0,
    items_completed INTEGER NOT NULL DEFAULT 0,
    last_processed_id TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_phase_progress_run_id ON phase_progress(run_id);
CREATE INDEX IF NOT EXISTS idx_phase_progress_phase ON phase_progress(phase);
CREATE UNIQUE INDEX IF NOT EXISTS idx_phase_progress_unique
    ON phase_progress(run_id, phase);

-- ============================================================================
-- Triggers for Updated Timestamps
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS benchmark_runs_updated_at
    AFTER UPDATE ON benchmark_runs
    FOR EACH ROW
BEGIN
    UPDATE benchmark_runs SET updated_at = datetime('now') WHERE id = NEW.id;
END;
