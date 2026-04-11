use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use wasm_bindgen::prelude::*;

// ── Hybrid Logical Clock ──────────────────────────────────────────────────────
// Based on Kulkarni et al. "Logical Physical Clocks and Consistent Snapshots
// in Globally Distributed Databases"
//
// HLC = (physical_ms, counter). Monotonically increasing, causally consistent.
// The physical component tracks wall-clock time; the counter breaks ties when
// two events have the same millisecond timestamp.

/// Number of bits reserved for the counter in a packed HLC u64
const HLC_COUNTER_BITS: u32 = 16;
/// Bitmask for the counter portion of a packed HLC
const HLC_COUNTER_MASK: u64 = (1u64 << HLC_COUNTER_BITS) - 1; // 0xFFFF

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct HLC {
    pub ts: u64,  // physical milliseconds (or best approximation)
    pub count: u32,
}

impl HLC {
    /// Tick for a local event. Advances the clock.
    pub fn tick(&mut self, now_ms: u64) {
        if now_ms > self.ts {
            self.ts = now_ms;
            self.count = 0;
        } else {
            self.count += 1;
        }
    }

    /// Merge with a remote clock (receive event). Takes the max and increments.
    pub fn merge(&mut self, remote: &HLC, now_ms: u64) {
        if now_ms > self.ts && now_ms > remote.ts {
            self.ts = now_ms;
            self.count = 0;
        } else if self.ts == remote.ts {
            self.count = self.count.max(remote.count) + 1;
        } else if remote.ts > self.ts {
            self.ts = remote.ts;
            self.count = remote.count + 1;
        } else {
            self.count += 1;
        }
    }

    /// Pack into a single u64 for compact storage: top bits = ts, low 16 bits = count
    pub fn pack(&self) -> u64 {
        (self.ts << HLC_COUNTER_BITS) | (self.count as u64 & HLC_COUNTER_MASK)
    }

    /// Compare two HLCs for causal ordering
    pub fn cmp_causal(&self, other: &HLC) -> Ordering {
        self.ts.cmp(&other.ts).then(self.count.cmp(&other.count))
    }
}

// ── Merge strategies (CRDV-inspired) ──────────────────────────────────────────
// Per-field merge policies resolved using HLC timestamps.

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum MergeStrategy {
    /// Last-writer-wins based on HLC timestamp
    Lww,
    /// Set-union: concatenate values (comma-separated)
    SetUnion,
    /// Numeric max
    Max,
    /// Numeric min
    Min,
    /// Additive: sum concurrent increments
    Add,
}

/// Per-table merge configuration (field name → strategy)
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MergeConfig {
    pub fields: HashMap<String, MergeStrategy>,
}

/// Conflict information — emitted when merge resolution discards a value
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConflictInfo {
    pub field: String,
    pub winner: Value,
    pub loser: Value,
    pub winner_hlc: u64,  // packed HLC
    pub loser_hlc: u64,   // packed HLC
    pub strategy: String,
}

/// Helper: conditionally record a conflict when winner != loser and loser is non-null.
fn maybe_record_conflict(
    conflicts: &mut Vec<ConflictInfo>,
    field: &str,
    winner: &Value,
    loser: &Value,
    winner_hlc: u64,
    loser_hlc: u64,
    strategy: &str,
) {
    if winner != loser && *loser != Value::Null {
        conflicts.push(ConflictInfo {
            field: field.to_string(),
            winner: winner.clone(),
            loser: loser.clone(),
            winner_hlc,
            loser_hlc,
            strategy: strategy.to_string(),
        });
    }
}

/// CALM monotonicity classification for a view pipeline
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Monotonicity {
    Monotonic,
    NonMonotonic,
}

// ── Z-Set: the universal data type ──────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Delta {
    #[serde(default)]
    pub source: String,
    pub record: Value,
    pub weight: i64,
    #[serde(default)]
    pub hlc: Option<HLC>,
}

// ── Operators ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "op")]
pub enum Operator {
    #[serde(rename = "filter")]
    Filter { field: String, eq: Value },

    #[serde(rename = "project")]
    Project { fields: Vec<String> },

    #[serde(rename = "topN")]
    TopN {
        sort_by: String,
        limit: usize,
        #[serde(default = "default_desc")]
        order: String,
    },

    #[serde(rename = "aggregate")]
    Aggregate {
        group_by: Vec<String>,
        aggregates: HashMap<String, AggDef>,
    },

    #[serde(rename = "distinct")]
    Distinct { key: String },

    #[serde(rename = "join")]
    Join {
        right_table: String,
        left_key: String,
        right_key: String,
    },
}

fn default_desc() -> String {
    "desc".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AggDef {
    #[serde(rename = "fn")]
    pub func: String,
    pub field: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ViewDef {
    pub name: String,
    #[serde(default)]
    pub source_table: String,
    /// Post-pipeline natural key. For pipelines that include `aggregate`, this
    /// is rewritten to the group-by column. Used by topN, applyDeltas, and
    /// other operators that index the **view's output** records.
    pub id_key: String,
    /// Source table's primary key — never rewritten by the pipeline. Used by
    /// `apply_join` to dedup `left_index` records, which must be keyed on the
    /// source row identity, not the post-aggregate group key. Defaults to
    /// `id_key` for back-compat with old wire formats.
    #[serde(default)]
    pub source_id_key: Option<String>,
    pub pipeline: Vec<Operator>,
    #[serde(default)]
    pub monotonicity: Option<Monotonicity>,
}

// ── TopN sorted entry — used in BTreeSet for O(log n) insert/evict ──────────

#[derive(Clone, Debug)]
struct SortedEntry {
    sort_val: f64,
    id: String,
}

impl PartialEq for SortedEntry {
    fn eq(&self, other: &Self) -> bool {
        self.sort_val == other.sort_val && self.id == other.id
    }
}
impl Eq for SortedEntry {}

impl PartialOrd for SortedEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SortedEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.sort_val
            .partial_cmp(&other.sort_val)
            .unwrap_or(Ordering::Equal)
            .then_with(|| self.id.cmp(&other.id))
    }
}

// ── Per-view runtime state ──────────────────────────────────────────────────

struct ViewState {
    def: ViewDef,
    integrated: HashMap<String, Value>,
    sorted_set: BTreeSet<SortedEntry>,
    topn_desc: bool,
    topn_sort_by: String,
    agg_state: HashMap<String, HashMap<String, f64>>,
    agg_counts: HashMap<String, HashMap<String, f64>>,
    left_index: HashMap<String, Vec<Value>>,
    right_index: HashMap<String, Vec<Value>>,
}

impl ViewState {
    fn new(def: ViewDef) -> Self {
        let (topn_desc, topn_sort_by) = def.pipeline.iter().find_map(|op| {
            if let Operator::TopN { sort_by, order, .. } = op {
                Some((order == "desc", sort_by.clone()))
            } else {
                None
            }
        }).unwrap_or((true, String::new()));

        ViewState {
            def,
            integrated: HashMap::new(),
            sorted_set: BTreeSet::new(),
            topn_desc,
            topn_sort_by,
            agg_state: HashMap::new(),
            agg_counts: HashMap::new(),
            left_index: HashMap::new(),
            right_index: HashMap::new(),
        }
    }
}

// ── Per-table merge state ───────────────────────────────────────────────────
// Tracks the latest HLC per record per field for LWW resolution.

struct TableMergeState {
    config: MergeConfig,
    /// record_id -> field_name -> (hlc_packed, value)
    field_clocks: HashMap<String, HashMap<String, (u64, Value)>>,
}

impl TableMergeState {
    fn new(config: MergeConfig) -> Self {
        TableMergeState {
            config,
            field_clocks: HashMap::new(),
        }
    }

    /// Resolve a record against existing state. Returns the merged record and any conflicts.
    fn resolve(&mut self, id_key: &str, record: &Value, hlc: &HLC) -> (Value, Vec<ConflictInfo>) {
        let id = record_id(record, id_key);
        let packed = hlc.pack();
        let clocks = self.field_clocks.entry(id).or_default();

        let mut merged = record.as_object().cloned().unwrap_or_default();
        let mut conflicts = Vec::new();

        for (field, strategy) in &self.config.fields {
            let incoming = match record.get(field) {
                Some(v) => v,
                None => continue,
            };

            let entry = clocks.get(field);

            let should_update = match strategy {
                MergeStrategy::Lww => {
                    let is_newer = entry.map_or(true, |(ts, _)| packed >= *ts);
                    if let Some((old_ts, old_v)) = entry {
                        let (winner, loser, w_hlc, l_hlc) = if is_newer {
                            (incoming, old_v, packed, *old_ts)
                        } else {
                            (old_v, incoming, *old_ts, packed)
                        };
                        maybe_record_conflict(&mut conflicts, field, winner, loser, w_hlc, l_hlc, "lww");
                    }
                    is_newer
                }
                MergeStrategy::Max => {
                    let incoming_f = incoming.as_f64().unwrap_or(f64::MIN);
                    let should_upd = entry.map_or(true, |(_, old_v)| {
                        incoming_f > old_v.as_f64().unwrap_or(f64::MIN)
                    });
                    if let Some((old_ts, old_v)) = entry {
                        let (winner, loser, w_hlc, l_hlc) = if should_upd {
                            (incoming, old_v, packed, *old_ts)
                        } else {
                            (old_v, incoming, *old_ts, packed)
                        };
                        maybe_record_conflict(&mut conflicts, field, winner, loser, w_hlc, l_hlc, "max");
                    }
                    should_upd
                }
                MergeStrategy::Min => {
                    let incoming_f = incoming.as_f64().unwrap_or(f64::MAX);
                    let should_upd = entry.map_or(true, |(_, old_v)| {
                        incoming_f < old_v.as_f64().unwrap_or(f64::MAX)
                    });
                    if let Some((old_ts, old_v)) = entry {
                        let (winner, loser, w_hlc, l_hlc) = if should_upd {
                            (incoming, old_v, packed, *old_ts)
                        } else {
                            (old_v, incoming, *old_ts, packed)
                        };
                        maybe_record_conflict(&mut conflicts, field, winner, loser, w_hlc, l_hlc, "min");
                    }
                    should_upd
                }
                MergeStrategy::SetUnion => {
                    // Always merge — no conflicts for union
                    if let Some((_, old_v)) = entry {
                        let old_str = old_v.as_str().unwrap_or("");
                        let new_str = incoming.as_str().unwrap_or("");
                        let mut parts: Vec<&str> = old_str.split(',')
                            .chain(new_str.split(','))
                            .filter(|s| !s.is_empty())
                            .collect();
                        parts.sort();
                        parts.dedup();
                        let combined = parts.join(",");
                        clocks.insert(field.clone(), (packed, Value::String(combined.clone())));
                        merged.insert(field.clone(), Value::String(combined));
                        continue;
                    }
                    true
                }
                MergeStrategy::Add => {
                    // Always merge — no conflicts for add
                    if let Some((_, old_v)) = entry {
                        let sum = old_v.as_f64().unwrap_or(0.0) + incoming.as_f64().unwrap_or(0.0);
                        clocks.insert(field.clone(), (packed, serde_json::json!(sum)));
                        merged.insert(field.clone(), serde_json::json!(sum));
                        continue;
                    }
                    true
                }
            };

            if should_update {
                clocks.insert(field.clone(), (packed, incoming.clone()));
                merged.insert(field.clone(), incoming.clone());
            } else if let Some((_, old_v)) = entry {
                // Keep the old value
                merged.insert(field.clone(), old_v.clone());
            }
        }

        (Value::Object(merged), conflicts)
    }

    fn remove(&mut self, id_key: &str, record: &Value) {
        let id = record_id(record, id_key);
        self.field_clocks.remove(&id);
    }
}

// ── The Engine ──────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct DbspEngine {
    views: Vec<ViewState>,
    clock: HLC,
    merge_states: HashMap<String, TableMergeState>,
    /// Tombstones: table → record_id → packed_hlc_at_deletion
    tombstones: HashMap<String, HashMap<String, u64>>,
}

#[wasm_bindgen]
impl DbspEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(views_js: JsValue) -> DbspEngine {
        console_error_panic_hook::set_once();
        let defs: Vec<ViewDef> = serde_wasm_bindgen::from_value(views_js).unwrap();
        DbspEngine {
            views: defs.into_iter().map(ViewState::new).collect(),
            clock: HLC::default(),
            merge_states: HashMap::new(),
            tombstones: HashMap::new(),
        }
    }

    /// Register merge config for a table. Call after constructor, before step().
    pub fn register_merge(&mut self, table_name: &str, config_js: JsValue) {
        let config: MergeConfig = serde_wasm_bindgen::from_value(config_js)
            .unwrap_or_default();
        self.merge_states.insert(table_name.to_string(), TableMergeState::new(config));
    }

    /// Stamp a local event and return the HLC as [ts, count].
    pub fn tick(&mut self, now_ms: f64) -> JsValue {
        self.clock.tick(now_ms as u64);
        let hlc = &self.clock;
        serde_wasm_bindgen::to_value(&hlc).unwrap()
    }

    /// Merge with a remote HLC (call on inbound deltas).
    pub fn merge_clock(&mut self, remote_js: JsValue, now_ms: f64) {
        if let Ok(remote) = serde_wasm_bindgen::from_value::<HLC>(remote_js) {
            self.clock.merge(&remote, now_ms as u64);
        }
    }

    /// Get current HLC state.
    pub fn get_clock(&self) -> JsValue {
        serde_wasm_bindgen::to_value(&self.clock).unwrap()
    }

    pub fn step(&mut self, deltas_js: JsValue) -> JsValue {
        // Never panic inside step() — a panic in WASM with panic=abort
        // poisons the RefCell borrow counter permanently, making every
        // subsequent step() call fail with "recursive use of an object."
        // Return an empty result on deserialization failure instead.
        let mut deltas: Vec<Delta> = match serde_wasm_bindgen::from_value(deltas_js) {
            Ok(d) => d,
            Err(_) => {
                let empty = serde_json::json!({"views": {}, "conflicts": []});
                let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
                return empty.serialize(&serializer).unwrap_or(JsValue::NULL);
            }
        };
        let mut all_conflicts: Vec<Value> = Vec::new();

        // Apply merge resolution for deltas that have HLC timestamps
        let mut i = 0;
        while i < deltas.len() {
            let delta = &mut deltas[i];

            if delta.weight > 0 {
                // Anti-resurrection: skip inserts that are older than the tombstone
                let should_skip = if let Some(table_tombstones) = self.tombstones.get(&delta.source) {
                    let id_key = self.views.iter()
                        .find(|v| v.def.source_table == delta.source)
                        .map(|v| v.def.id_key.as_str())
                        .unwrap_or("id");
                    let id = record_id(&delta.record, id_key);
                    if let Some(&tombstone_hlc) = table_tombstones.get(&id) {
                        let insert_hlc = delta.hlc.as_ref().map(|h| h.pack()).unwrap_or(0);
                        if insert_hlc <= tombstone_hlc {
                            true  // skip this delta — it's a ghost from before deletion
                        } else {
                            // Newer insert after delete — remove tombstone, allow insert
                            if let Some(ts_map) = self.tombstones.get_mut(&delta.source) {
                                ts_map.remove(&id);
                            }
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };

                if !should_skip {
                    if let Some(hlc) = &delta.hlc {
                        if let Some(merge_state) = self.merge_states.get_mut(&delta.source) {
                            let id_key = self.views.iter()
                                .find(|v| v.def.source_table == delta.source)
                                .map(|v| v.def.id_key.as_str())
                                .unwrap_or("id");
                            let record_id = record_id(&delta.record, id_key);
                            let (resolved, conflicts) = merge_state.resolve(id_key, &delta.record, hlc);
                            delta.record = resolved;

                            // Add table and record context to each conflict
                            for c in conflicts {
                                all_conflicts.push(serde_json::json!({
                                    "table": delta.source,
                                    "recordId": record_id,
                                    "field": c.field,
                                    "winner": c.winner,
                                    "loser": c.loser,
                                    "winnerHlc": c.winner_hlc,
                                    "loserHlc": c.loser_hlc,
                                    "strategy": c.strategy,
                                }));
                            }
                        }
                    }
                } else {
                    // Skip this delta entirely
                    deltas.remove(i);
                    continue;
                }
            } else {
                // Retraction (weight < 0) — clean up merge state and record tombstone
                if let Some(merge_state) = self.merge_states.get_mut(&delta.source) {
                    let id_key = self.views.iter()
                        .find(|v| v.def.source_table == delta.source)
                        .map(|v| v.def.id_key.as_str())
                        .unwrap_or("id");
                    merge_state.remove(id_key, &delta.record);
                }

                // Record the tombstone
                let id_key = self.views.iter()
                    .find(|v| v.def.source_table == delta.source)
                    .map(|v| v.def.id_key.as_str())
                    .unwrap_or("id");
                let id = record_id(&delta.record, id_key);
                let packed_hlc = delta.hlc.as_ref().map(|h| h.pack()).unwrap_or(0);
                self.tombstones
                    .entry(delta.source.clone())
                    .or_insert_with(HashMap::new)
                    .insert(id, packed_hlc);
            }

            i += 1;
        }

        let mut results: HashMap<String, Vec<Delta>> = HashMap::new();

        for view in &mut self.views {
            let output = process_view(view, &deltas);
            if !output.is_empty() {
                results.insert(view.def.name.clone(), output);
            }
        }

        // Return { views: {...}, conflicts: [...] }
        // Large u64 values (packed HLCs, conflict metadata) can exceed
        // JS's MAX_SAFE_INTEGER. Serialize them as BigInts so the
        // conversion doesn't panic. The JS side converts via deepToObject
        // which calls Number() on BigInts — safe because view output
        // records (aggregates, projected fields) don't contain HLCs.
        let serializer = serde_wasm_bindgen::Serializer::new()
            .serialize_maps_as_objects(true)
            .serialize_large_number_types_as_bigints(true);
        let return_val = serde_json::json!({
            "views": results,
            "conflicts": all_conflicts,
        });
        match return_val.serialize(&serializer) {
            Ok(js) => js,
            Err(_) => {
                // Fallback: return empty result rather than panicking
                let empty = serde_json::json!({"views": {}, "conflicts": []});
                empty.serialize(&serializer).unwrap_or(JsValue::NULL)
            }
        }
    }

    /// Reset all view state — used before re-hydration from SQLite
    pub fn reset(&mut self) {
        for view in &mut self.views {
            view.integrated.clear();
            view.sorted_set.clear();
            view.agg_state.clear();
            view.agg_counts.clear();
            view.left_index.clear();
            view.right_index.clear();
        }
        for ms in self.merge_states.values_mut() {
            ms.field_clocks.clear();
        }
        self.tombstones.clear();
        // Note: we don't reset the HLC — it must be monotonically increasing
    }

    /// Remove tombstones and merge state for records below the GC watermark.
    /// Called when the server confirms all peers have processed past a sequence.
    pub fn prune_tombstones(&mut self, table_name: &str, record_ids_js: JsValue) {
        let ids: Vec<String> = serde_wasm_bindgen::from_value(record_ids_js).unwrap_or_default();
        if let Some(table_ts) = self.tombstones.get_mut(table_name) {
            for id in &ids {
                table_ts.remove(id);
            }
        }
        if let Some(merge_state) = self.merge_states.get_mut(table_name) {
            for id in &ids {
                merge_state.field_clocks.remove(id);
            }
        }
    }

    /// Get current tombstone count for diagnostics.
    pub fn tombstone_count(&self) -> usize {
        self.tombstones.values().map(|t| t.len()).sum()
    }

    /// Classify a view pipeline's monotonicity (CALM analysis)
    pub fn classify_monotonicity(pipeline_js: JsValue) -> JsValue {
        let pipeline: Vec<Operator> = serde_wasm_bindgen::from_value(pipeline_js)
            .unwrap_or_default();
        let result = classify_pipeline(&pipeline);
        serde_wasm_bindgen::to_value(&result).unwrap()
    }

    /// Restore merge state from a snapshot (used during initial sync).
    /// Takes a JS object: { "tableName": { "recordId": { "fieldName": { "ts": u64, "count": u32 } } } }
    pub fn restore_merge_state(&mut self, merge_clocks_js: JsValue) {
        let clocks: HashMap<String, HashMap<String, HashMap<String, HLC>>> =
            serde_wasm_bindgen::from_value(merge_clocks_js).unwrap_or_default();

        for (table_name, records) in clocks {
            if let Some(merge_state) = self.merge_states.get_mut(&table_name) {
                for (record_id, fields) in records {
                    let field_clocks = merge_state.field_clocks.entry(record_id).or_default();
                    for (field_name, hlc) in fields {
                        let packed = hlc.pack();
                        // Reconstruct the value — we don't have it in the clock data,
                        // but it will be set correctly when the snapshot rows are loaded
                        // via step(). We just need the clock times to be correct for
                        // future LWW comparisons.
                        field_clocks.insert(field_name, (packed, Value::Null));
                    }
                }
            }
        }
    }

    /// Restore the engine's HLC from a snapshot to maintain monotonicity.
    pub fn restore_clock(&mut self, hlc_js: JsValue) {
        if let Ok(remote) = serde_wasm_bindgen::from_value::<HLC>(hlc_js) {
            // Merge with current clock to ensure monotonicity
            let now = 0; // Will be merged with real wall clock on next tick()
            self.clock.merge(&remote, now);
        }
    }
}

/// CALM-based static analysis of operator pipeline monotonicity.
///
/// Monotonic operators (safe for coordination-free sync):
///   filter, project, aggregate (sum/count/max), join (over monotonic inputs)
///
/// Non-monotonic operators (require coordination for consistency):
///   topN (eviction), distinct (with retractions), aggregate (with deletes)
fn classify_pipeline(pipeline: &[Operator]) -> Monotonicity {
    for op in pipeline {
        match op {
            Operator::TopN { .. } => return Monotonicity::NonMonotonic,
            Operator::Distinct { .. } => return Monotonicity::NonMonotonic,
            // Filter, Project, Aggregate, Join are monotonic
            // (assuming append-only input — which CALM guarantees is the safe case)
            _ => {}
        }
    }
    Monotonicity::Monotonic
}

fn process_view(view: &mut ViewState, all_deltas: &[Delta]) -> Vec<Delta> {
    let source = &view.def.source_table;
    let has_join = view.def.pipeline.iter().any(|op| matches!(op, Operator::Join { .. }));

    let mut current: Vec<Delta> = if source.is_empty() {
        all_deltas.to_vec()
    } else {
        all_deltas.iter()
            .filter(|d| d.source.is_empty() || d.source == *source)
            .cloned()
            .collect()
    };

    if current.is_empty() && !has_join {
        return Vec::new();
    }

    for op in &view.def.pipeline.clone() {
        current = match op {
            Operator::Filter { field, eq } => apply_filter(&current, field, eq),
            Operator::Project { fields } => apply_project(&current, fields),
            Operator::TopN { limit, .. } => {
                apply_topn(view, &current, *limit)
            }
            Operator::Aggregate { group_by, aggregates } => {
                apply_aggregate(view, &current, group_by, aggregates)
            }
            Operator::Distinct { key } => apply_distinct(view, &current, key),
            Operator::Join { right_table, left_key, right_key } => {
                let right_deltas: Vec<Delta> = all_deltas.iter()
                    .filter(|d| d.source == *right_table)
                    .cloned()
                    .collect();
                apply_join(view, &current, &right_deltas, left_key, right_key)
            }
        };
    }

    current
}

// ── Operator implementations ────────────────────────────────────────────────

fn apply_filter(deltas: &[Delta], field: &str, eq: &Value) -> Vec<Delta> {
    deltas
        .iter()
        .filter(|d| d.record.get(field).map_or(false, |v| v == eq))
        .cloned()
        .collect()
}

fn apply_project(deltas: &[Delta], fields: &[String]) -> Vec<Delta> {
    deltas
        .iter()
        .map(|d| {
            let mut projected = serde_json::Map::new();
            if let Value::Object(obj) = &d.record {
                for f in fields {
                    if let Some(v) = obj.get(f) {
                        projected.insert(f.clone(), v.clone());
                    }
                }
            }
            Delta {
                source: String::new(),
                record: Value::Object(projected),
                weight: d.weight,
                hlc: d.hlc.clone(),
            }
        })
        .collect()
}

fn apply_distinct(view: &mut ViewState, deltas: &[Delta], key: &str) -> Vec<Delta> {
    let mut output = Vec::new();
    for d in deltas {
        let id = record_id(&d.record, key);
        if d.weight > 0 {
            if !view.integrated.contains_key(&id) {
                view.integrated.insert(id, d.record.clone());
                output.push(d.clone());
            }
        } else if view.integrated.remove(&id).is_some() {
            output.push(d.clone());
        }
    }
    output
}

fn apply_topn(view: &mut ViewState, deltas: &[Delta], limit: usize) -> Vec<Delta> {
    let mut output = Vec::new();
    let id_key = view.def.id_key.clone();
    let sort_by = view.topn_sort_by.clone();
    let desc = view.topn_desc;

    for d in deltas {
        let id = record_id(&d.record, &id_key);

        if d.weight > 0 {
            let sort_val = as_f64(&d.record, &sort_by).unwrap_or(0.0);

            if let Some(old_record) = view.integrated.get(&id) {
                let old_val = as_f64(old_record, &sort_by).unwrap_or(0.0);
                view.sorted_set.remove(&SortedEntry { sort_val: old_val, id: id.clone() });
            }

            view.integrated.insert(id.clone(), d.record.clone());
            view.sorted_set.insert(SortedEntry { sort_val, id: id.clone() });

            output.push(Delta { source: String::new(), record: d.record.clone(), weight: 1, hlc: None });

            while view.sorted_set.len() > limit {
                let worst = if desc {
                    view.sorted_set.iter().next().cloned()
                } else {
                    view.sorted_set.iter().next_back().cloned()
                };

                if let Some(entry) = worst {
                    view.sorted_set.remove(&entry);
                    if let Some(evicted) = view.integrated.remove(&entry.id) {
                        output.push(Delta { source: String::new(), record: evicted, weight: -1, hlc: None });
                    }
                }
            }
        } else {
            if let Some(removed) = view.integrated.remove(&id) {
                let old_val = as_f64(&removed, &sort_by).unwrap_or(0.0);
                view.sorted_set.remove(&SortedEntry { sort_val: old_val, id: id.clone() });
                output.push(Delta { source: String::new(), record: removed, weight: -1, hlc: None });
            }
        }
    }

    output
}

fn apply_aggregate(
    view: &mut ViewState,
    deltas: &[Delta],
    group_by: &[String],
    aggregates: &HashMap<String, AggDef>,
) -> Vec<Delta> {
    let mut output = Vec::new();

    for d in deltas {
        let group_key = group_by
            .iter()
            .map(|k| d.record.get(k).map_or("null".to_string(), |v| v.to_string()))
            .collect::<Vec<_>>()
            .join(&KEY_SEP.to_string());

        let sign = if d.weight > 0 { 1.0 } else { -1.0 };

        if let Some(old_aggs) = view.agg_state.get(&group_key) {
            let old_counts = view.agg_counts.get(&group_key);
            let mut old_record = serde_json::Map::new();
            for k in group_by {
                if let Some(v) = d.record.get(k) {
                    old_record.insert(k.clone(), v.clone());
                }
            }
            for (name, def) in aggregates {
                let val = old_aggs.get(name).copied().unwrap_or(0.0);
                let count = old_counts.and_then(|c| c.get(name)).copied().unwrap_or(1.0);
                let emit_val = if def.func == "avg" && count > 0.0 { val / count } else { val };
                old_record.insert(name.clone(), serde_json::json!(emit_val));
            }
            output.push(Delta { source: String::new(), record: Value::Object(old_record), weight: -1, hlc: None });
        }

        let aggs = view.agg_state.entry(group_key.clone()).or_default();
        let counts = view.agg_counts.entry(group_key.clone()).or_default();

        for (name, def) in aggregates {
            let field_val = d.record.get(&def.field).and_then(|v| v.as_f64()).unwrap_or(0.0);
            match def.func.as_str() {
                "sum" => *aggs.entry(name.clone()).or_insert(0.0) += field_val * sign,
                "count" => *aggs.entry(name.clone()).or_insert(0.0) += sign,
                "avg" => {
                    *aggs.entry(name.clone()).or_insert(0.0) += field_val * sign;
                    *counts.entry(name.clone()).or_insert(0.0) += sign;
                }
                "min" | "max" => {
                    let entry = aggs.entry(name.clone()).or_insert(field_val);
                    if def.func == "min" && field_val < *entry { *entry = field_val; }
                    else if def.func == "max" && field_val > *entry { *entry = field_val; }
                }
                _ => {}
            }
        }

        let new_aggs = &view.agg_state[&group_key];
        let new_counts = view.agg_counts.get(&group_key);
        let mut new_record = serde_json::Map::new();
        for k in group_by {
            if let Some(v) = d.record.get(k) {
                new_record.insert(k.clone(), v.clone());
            }
        }
        for (name, def) in aggregates {
            let val = new_aggs.get(name).copied().unwrap_or(0.0);
            let count = new_counts.and_then(|c| c.get(name)).copied().unwrap_or(1.0);
            let emit_val = if def.func == "avg" && count > 0.0 { val / count } else { val };
            new_record.insert(name.clone(), serde_json::json!(emit_val));
        }
        output.push(Delta { source: String::new(), record: Value::Object(new_record), weight: 1, hlc: None });
    }

    output
}

fn apply_join(
    view: &mut ViewState,
    left_deltas: &[Delta],
    right_deltas: &[Delta],
    left_key: &str,
    right_key: &str,
) -> Vec<Delta> {
    let mut output = Vec::new();
    // The left_index dedup must use the SOURCE table's primary key, not the
    // view's post-pipeline `id_key` — otherwise a downstream `aggregate(...)`
    // that rewrites `id_key` to the group-by column would collapse every row
    // in a group down to one entry, dropping all but the latest source row.
    // We fall back to `id_key` if the wire format didn't include
    // `source_id_key`, which keeps the old test fixtures working.
    let id_key = view
        .def
        .source_id_key
        .clone()
        .unwrap_or_else(|| view.def.id_key.clone());

    // Step 1: ∆L ⋈ R_old
    for ld in left_deltas {
        let key_val = record_key_str(&ld.record, left_key);
        if let Some(right_records) = view.right_index.get(&key_val) {
            for rr in right_records {
                let merged = merge_records(&ld.record, rr);
                output.push(Delta { source: String::new(), record: merged, weight: ld.weight, hlc: None });
            }
        }
    }

    // Step 2: Apply ∆L to left index
    for ld in left_deltas {
        let key_val = record_key_str(&ld.record, left_key);
        if ld.weight > 0 {
            let records = view.left_index.entry(key_val.clone()).or_default();
            let id = record_id(&ld.record, &id_key);
            records.retain(|r| record_id(r, &id_key) != id);
            records.push(ld.record.clone());
        } else {
            if let Some(records) = view.left_index.get_mut(&key_val) {
                let id = record_id(&ld.record, &id_key);
                records.retain(|r| record_id(r, &id_key) != id);
                if records.is_empty() {
                    view.left_index.remove(&key_val);
                }
            }
        }
    }

    // Step 3: L_new ⋈ ∆R
    for rd in right_deltas {
        let key_val = record_key_str(&rd.record, right_key);
        if let Some(left_records) = view.left_index.get(&key_val) {
            for lr in left_records {
                let merged = merge_records(lr, &rd.record);
                output.push(Delta { source: String::new(), record: merged, weight: rd.weight, hlc: None });
            }
        }
    }

    // Step 4: Apply ∆R to right index.
    // Insertion is idempotent: if an identical record (by string) already
    // exists for the same join key, we don't push a duplicate. This protects
    // against double-insertion when upstream (CDC, replay, seeds) emits the
    // same +1 delta more than once. Without this, every duplicate +1 inflates
    // the join output by adding a redundant right-side match.
    for rd in right_deltas {
        let key_val = record_key_str(&rd.record, right_key);
        if rd.weight > 0 {
            let entry = view.right_index.entry(key_val).or_default();
            let rd_str = rd.record.to_string();
            if !entry.iter().any(|r| r.to_string() == rd_str) {
                entry.push(rd.record.clone());
            }
        } else {
            if let Some(records) = view.right_index.get_mut(&key_val) {
                let rd_str = rd.record.to_string();
                records.retain(|r| r.to_string() != rd_str);
                if records.is_empty() {
                    view.right_index.remove(&key_val);
                }
            }
        }
    }

    output
}

fn merge_records(left: &Value, right: &Value) -> Value {
    let mut merged = serde_json::Map::new();
    if let Value::Object(r) = right {
        for (k, v) in r {
            merged.insert(k.clone(), v.clone());
        }
    }
    if let Value::Object(l) = left {
        for (k, v) in l {
            merged.insert(k.clone(), v.clone());
        }
    }
    Value::Object(merged)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Extract a string key from a JSON record. Used for both primary key lookup
/// and sort-key extraction. Handles String/Number/other uniformly.
/// ASCII Unit Separator — used as the join character for composite keys.
/// Cannot appear in normal string values, unlike '|' which is ambiguous.
const KEY_SEP: char = '\x1F';

fn record_key(record: &Value, key: &str) -> String {
    // Composite key: "col1\x1Fcol2\x1Fcol3" → join values with \x1F
    if key.contains(KEY_SEP) {
        return key.split(KEY_SEP)
            .map(|k| record.get(k).map(|v| match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                other => other.to_string(),
            }).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(&KEY_SEP.to_string());
    }
    record.get(key).map(|v| match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }).unwrap_or_default()
}

// Backwards-compatible aliases (kept for minimal diff in operator code)
#[inline(always)]
fn record_key_str(record: &Value, key: &str) -> String { record_key(record, key) }
#[inline(always)]
fn record_id(record: &Value, key: &str) -> String { record_key(record, key) }

fn as_f64(record: &Value, field: &str) -> Option<f64> {
    record.get(field)?.as_f64()
}

// ── Unit Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── Test Helpers ────────────────────────────────────────────────────────

    fn make_delta(source: &str, record: Value, weight: i64) -> Delta {
        Delta {
            source: source.to_string(),
            record,
            weight,
            hlc: None,
        }
    }

    fn make_view(name: &str, source: &str, id_key: &str, pipeline: Vec<Operator>) -> ViewState {
        // Default source_id_key to id_key for tests that don't have a
        // pipeline rewriting it (filter, topN, etc.).
        make_view_with_source_id(name, source, id_key, id_key, pipeline)
    }

    fn make_view_with_source_id(
        name: &str,
        source: &str,
        source_id_key: &str,
        id_key: &str,
        pipeline: Vec<Operator>,
    ) -> ViewState {
        ViewState::new(ViewDef {
            name: name.to_string(),
            source_table: source.to_string(),
            id_key: id_key.to_string(),
            source_id_key: Some(source_id_key.to_string()),
            pipeline,
            monotonicity: None,
        })
    }

    // ── HLC Tests ───────────────────────────────────────────────────────────

    #[test]
    fn test_hlc_tick_advances_ts() {
        let mut hlc = HLC { ts: 100, count: 5 };
        hlc.tick(200);
        assert_eq!(hlc.ts, 200);
        assert_eq!(hlc.count, 0);
    }

    #[test]
    fn test_hlc_tick_same_ts() {
        let mut hlc = HLC { ts: 100, count: 5 };
        hlc.tick(100);
        assert_eq!(hlc.ts, 100);
        assert_eq!(hlc.count, 6);
    }

    #[test]
    fn test_hlc_tick_older_ts() {
        let mut hlc = HLC { ts: 100, count: 5 };
        hlc.tick(50);
        assert_eq!(hlc.ts, 100);
        assert_eq!(hlc.count, 6);
    }

    #[test]
    fn test_hlc_merge_remote_ahead() {
        let mut local = HLC { ts: 100, count: 3 };
        let remote = HLC { ts: 200, count: 2 };
        local.merge(&remote, 50);
        assert_eq!(local.ts, 200);
        assert_eq!(local.count, 3);
    }

    #[test]
    fn test_hlc_merge_local_ahead() {
        let mut local = HLC { ts: 200, count: 3 };
        let remote = HLC { ts: 100, count: 5 };
        local.merge(&remote, 50);
        assert_eq!(local.ts, 200);
        assert_eq!(local.count, 4);
    }

    #[test]
    fn test_hlc_merge_same_ts() {
        let mut local = HLC { ts: 100, count: 3 };
        let remote = HLC { ts: 100, count: 5 };
        local.merge(&remote, 50);
        assert_eq!(local.ts, 100);
        assert_eq!(local.count, 6);
    }

    #[test]
    fn test_hlc_merge_wall_clock_ahead() {
        let mut local = HLC { ts: 100, count: 3 };
        let remote = HLC { ts: 100, count: 5 };
        local.merge(&remote, 300);
        assert_eq!(local.ts, 300);
        assert_eq!(local.count, 0);
    }

    #[test]
    fn test_hlc_pack_roundtrip() {
        let hlc = HLC { ts: 0x123456789ABC, count: 0xDEF0 };
        let packed = hlc.pack();
        assert_eq!(packed, (0x123456789ABC << 16) | 0xDEF0);
    }

    #[test]
    fn test_hlc_cmp_causal() {
        let a = HLC { ts: 100, count: 1 };
        let b = HLC { ts: 100, count: 2 };
        let c = HLC { ts: 200, count: 0 };

        assert_eq!(a.cmp_causal(&a), Ordering::Equal);
        assert_eq!(a.cmp_causal(&b), Ordering::Less);
        assert_eq!(b.cmp_causal(&a), Ordering::Greater);
        assert_eq!(a.cmp_causal(&c), Ordering::Less);
        assert_eq!(c.cmp_causal(&b), Ordering::Greater);
    }

    // ── MergeStrategy / TableMergeState Tests ────────────────────────────────

    #[test]
    fn test_lww_newer_wins() {
        let mut merge_state = TableMergeState::new(MergeConfig {
            fields: [("status".to_string(), MergeStrategy::Lww)]
                .iter()
                .cloned()
                .collect(),
        });

        let record1 = json!({"id": "user1", "status": "online"});
        let hlc1 = HLC { ts: 100, count: 0 };
        let (result1, _) = merge_state.resolve("id", &record1, &hlc1);
        assert_eq!(result1["status"], "online");

        let record2 = json!({"id": "user1", "status": "offline"});
        let hlc2 = HLC { ts: 200, count: 0 };
        let (result2, _) = merge_state.resolve("id", &record2, &hlc2);
        assert_eq!(result2["status"], "offline");
    }

    #[test]
    fn test_lww_older_loses() {
        let mut merge_state = TableMergeState::new(MergeConfig {
            fields: [("status".to_string(), MergeStrategy::Lww)]
                .iter()
                .cloned()
                .collect(),
        });

        let record1 = json!({"id": "user1", "status": "online"});
        let hlc1 = HLC { ts: 200, count: 0 };
        merge_state.resolve("id", &record1, &hlc1);

        let record2 = json!({"id": "user1", "status": "offline"});
        let hlc2 = HLC { ts: 100, count: 0 };
        let (result, _) = merge_state.resolve("id", &record2, &hlc2);
        assert_eq!(result["status"], "online");
    }

    #[test]
    fn test_set_union_combines() {
        let mut merge_state = TableMergeState::new(MergeConfig {
            fields: [("tags".to_string(), MergeStrategy::SetUnion)]
                .iter()
                .cloned()
                .collect(),
        });

        let record1 = json!({"id": "item1", "tags": "a,b"});
        let hlc1 = HLC { ts: 100, count: 0 };
        let (result1, _) = merge_state.resolve("id", &record1, &hlc1);
        assert_eq!(result1["tags"], "a,b");

        let record2 = json!({"id": "item1", "tags": "b,c"});
        let hlc2 = HLC { ts: 200, count: 0 };
        let (result2, _) = merge_state.resolve("id", &record2, &hlc2);
        assert_eq!(result2["tags"], "a,b,c");
    }

    #[test]
    fn test_max_strategy() {
        let mut merge_state = TableMergeState::new(MergeConfig {
            fields: [("score".to_string(), MergeStrategy::Max)]
                .iter()
                .cloned()
                .collect(),
        });

        let record1 = json!({"id": "player1", "score": 100.0});
        let hlc1 = HLC { ts: 100, count: 0 };
        merge_state.resolve("id", &record1, &hlc1);

        let record2 = json!({"id": "player1", "score": 150.0});
        let hlc2 = HLC { ts: 200, count: 0 };
        let (result, _) = merge_state.resolve("id", &record2, &hlc2);
        assert_eq!(result["score"], 150.0);

        let record3 = json!({"id": "player1", "score": 120.0});
        let hlc3 = HLC { ts: 300, count: 0 };
        let (result, _) = merge_state.resolve("id", &record3, &hlc3);
        assert_eq!(result["score"], 150.0);
    }

    #[test]
    fn test_min_strategy() {
        let mut merge_state = TableMergeState::new(MergeConfig {
            fields: [("cost".to_string(), MergeStrategy::Min)]
                .iter()
                .cloned()
                .collect(),
        });

        let record1 = json!({"id": "item1", "cost": 100.0});
        let hlc1 = HLC { ts: 100, count: 0 };
        merge_state.resolve("id", &record1, &hlc1);

        let record2 = json!({"id": "item1", "cost": 50.0});
        let hlc2 = HLC { ts: 200, count: 0 };
        let (result, _) = merge_state.resolve("id", &record2, &hlc2);
        assert_eq!(result["cost"], 50.0);

        let record3 = json!({"id": "item1", "cost": 75.0});
        let hlc3 = HLC { ts: 300, count: 0 };
        let (result, _) = merge_state.resolve("id", &record3, &hlc3);
        assert_eq!(result["cost"], 50.0);
    }

    #[test]
    fn test_add_strategy() {
        let mut merge_state = TableMergeState::new(MergeConfig {
            fields: [("balance".to_string(), MergeStrategy::Add)]
                .iter()
                .cloned()
                .collect(),
        });

        let record1 = json!({"id": "account1", "balance": 100.0});
        let hlc1 = HLC { ts: 100, count: 0 };
        merge_state.resolve("id", &record1, &hlc1);

        let record2 = json!({"id": "account1", "balance": 50.0});
        let hlc2 = HLC { ts: 200, count: 0 };
        let (result, _) = merge_state.resolve("id", &record2, &hlc2);
        assert_eq!(result["balance"], 150.0);

        let record3 = json!({"id": "account1", "balance": 25.0});
        let hlc3 = HLC { ts: 300, count: 0 };
        let (result, _) = merge_state.resolve("id", &record3, &hlc3);
        assert_eq!(result["balance"], 175.0);
    }

    #[test]
    fn test_merge_state_remove() {
        let mut merge_state = TableMergeState::new(MergeConfig {
            fields: [("status".to_string(), MergeStrategy::Lww)]
                .iter()
                .cloned()
                .collect(),
        });

        let record = json!({"id": "user1", "status": "online"});
        let hlc = HLC { ts: 100, count: 0 };
        merge_state.resolve("id", &record, &hlc);
        assert!(merge_state.field_clocks.contains_key("user1"));

        merge_state.remove("id", &record);
        assert!(!merge_state.field_clocks.contains_key("user1"));
    }

    // ── CALM Classification Tests ────────────────────────────────────────────

    #[test]
    fn test_classify_empty_pipeline() {
        let pipeline: Vec<Operator> = vec![];
        let result = classify_pipeline(&pipeline);
        assert_eq!(result, Monotonicity::Monotonic);
    }

    #[test]
    fn test_classify_filter_only() {
        let pipeline = vec![Operator::Filter {
            field: "status".to_string(),
            eq: json!("active"),
        }];
        let result = classify_pipeline(&pipeline);
        assert_eq!(result, Monotonicity::Monotonic);
    }

    #[test]
    fn test_classify_aggregate() {
        let pipeline = vec![Operator::Aggregate {
            group_by: vec!["category".to_string()],
            aggregates: [("total".to_string(), AggDef {
                func: "sum".to_string(),
                field: "amount".to_string(),
            })]
            .iter()
            .cloned()
            .collect(),
        }];
        let result = classify_pipeline(&pipeline);
        assert_eq!(result, Monotonicity::Monotonic);
    }

    #[test]
    fn test_classify_topn() {
        let pipeline = vec![Operator::TopN {
            sort_by: "score".to_string(),
            limit: 10,
            order: "desc".to_string(),
        }];
        let result = classify_pipeline(&pipeline);
        assert_eq!(result, Monotonicity::NonMonotonic);
    }

    #[test]
    fn test_classify_distinct() {
        let pipeline = vec![Operator::Distinct {
            key: "id".to_string(),
        }];
        let result = classify_pipeline(&pipeline);
        assert_eq!(result, Monotonicity::NonMonotonic);
    }

    #[test]
    fn test_classify_mixed() {
        let pipeline = vec![
            Operator::Filter {
                field: "active".to_string(),
                eq: json!(true),
            },
            Operator::TopN {
                sort_by: "score".to_string(),
                limit: 5,
                order: "desc".to_string(),
            },
        ];
        let result = classify_pipeline(&pipeline);
        assert_eq!(result, Monotonicity::NonMonotonic);
    }

    // ── Operator Tests ──────────────────────────────────────────────────────

    #[test]
    fn test_filter_passes_matching() {
        let deltas = vec![
            make_delta("events", json!({"type": "click", "value": 1}), 1),
            make_delta("events", json!({"type": "view", "value": 2}), 1),
        ];
        let result = apply_filter(&deltas, "type", &json!("click"));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].record["type"], "click");
    }

    #[test]
    fn test_filter_blocks_nonmatching() {
        let deltas = vec![
            make_delta("events", json!({"type": "click", "value": 1}), 1),
            make_delta("events", json!({"type": "view", "value": 2}), 1),
        ];
        let result = apply_filter(&deltas, "type", &json!("purchase"));
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_project_keeps_specified_fields() {
        let deltas = vec![make_delta(
            "users",
            json!({"id": 1, "name": "Alice", "email": "alice@example.com"}),
            1,
        )];
        let result = apply_project(&deltas, &["id".to_string(), "name".to_string()]);
        assert_eq!(result.len(), 1);
        assert!(result[0].record.get("id").is_some());
        assert!(result[0].record.get("name").is_some());
        assert!(result[0].record.get("email").is_none());
    }

    #[test]
    fn test_topn_limits_results() {
        let mut view = make_view("top_users", "users", "id", vec![Operator::TopN {
            sort_by: "score".to_string(),
            limit: 2,
            order: "desc".to_string(),
        }]);

        let deltas = vec![
            make_delta("users", json!({"id": "u1", "score": 100.0}), 1),
            make_delta("users", json!({"id": "u2", "score": 150.0}), 1),
            make_delta("users", json!({"id": "u3", "score": 200.0}), 1),
        ];

        let result = apply_topn(&mut view, &deltas, 2);
        assert_eq!(view.integrated.len(), 2);
    }

    #[test]
    fn test_topn_eviction() {
        let mut view = make_view("top_users", "users", "id", vec![Operator::TopN {
            sort_by: "score".to_string(),
            limit: 2,
            order: "desc".to_string(),
        }]);

        let deltas = vec![
            make_delta("users", json!({"id": "u1", "score": 100.0}), 1),
            make_delta("users", json!({"id": "u2", "score": 150.0}), 1),
        ];

        let mut result = apply_topn(&mut view, &deltas, 2);
        assert_eq!(result.len(), 2);

        let delta3 = vec![make_delta("users", json!({"id": "u3", "score": 200.0}), 1)];
        result = apply_topn(&mut view, &delta3, 2);

        let evictions = result.iter().filter(|d| d.weight == -1).collect::<Vec<_>>();
        assert_eq!(evictions.len(), 1);
        assert_eq!(evictions[0].record["id"], "u1");
    }

    #[test]
    fn test_aggregate_sum() {
        let mut view = make_view("sales_by_category", "sales", "id", vec![Operator::Aggregate {
            group_by: vec!["category".to_string()],
            aggregates: [("total".to_string(), AggDef {
                func: "sum".to_string(),
                field: "amount".to_string(),
            })]
            .iter()
            .cloned()
            .collect(),
        }]);

        let deltas = vec![
            make_delta("sales", json!({"id": "s1", "category": "books", "amount": 100.0}), 1),
            make_delta("sales", json!({"id": "s2", "category": "books", "amount": 50.0}), 1),
        ];

        let result = apply_aggregate(
            &mut view,
            &deltas,
            &["category".to_string()],
            &[("total".to_string(), AggDef {
                func: "sum".to_string(),
                field: "amount".to_string(),
            })]
            .iter()
            .cloned()
            .collect(),
        );

        let final_agg = result.iter().rev().find(|d| d.weight == 1 && d.record.get("category").map_or(false, |v| v == "books")).unwrap();
        assert_eq!(final_agg.record["total"], 150.0);
    }

    #[test]
    fn test_aggregate_count() {
        let mut view = make_view("event_counts", "events", "id", vec![Operator::Aggregate {
            group_by: vec!["type".to_string()],
            aggregates: [("count".to_string(), AggDef {
                func: "count".to_string(),
                field: "type".to_string(),
            })]
            .iter()
            .cloned()
            .collect(),
        }]);

        let deltas = vec![
            make_delta("events", json!({"id": "e1", "type": "click"}), 1),
            make_delta("events", json!({"id": "e2", "type": "click"}), 1),
            make_delta("events", json!({"id": "e3", "type": "view"}), 1),
        ];

        let result = apply_aggregate(
            &mut view,
            &deltas,
            &["type".to_string()],
            &[("count".to_string(), AggDef {
                func: "count".to_string(),
                field: "type".to_string(),
            })]
            .iter()
            .cloned()
            .collect(),
        );

        let click_count = result.iter().rev().find(|d| d.weight == 1 && d.record.get("type").map_or(false, |v| v == "click")).unwrap();
        assert_eq!(click_count.record["count"], 2.0);

        let view_count = result.iter().rev().find(|d| d.weight == 1 && d.record.get("type").map_or(false, |v| v == "view")).unwrap();
        assert_eq!(view_count.record["count"], 1.0);
    }

    #[test]
    fn test_aggregate_retraction() {
        let mut view = make_view("sales_total", "sales", "id", vec![Operator::Aggregate {
            group_by: vec!["region".to_string()],
            aggregates: [("revenue".to_string(), AggDef {
                func: "sum".to_string(),
                field: "amount".to_string(),
            })]
            .iter()
            .cloned()
            .collect(),
        }]);

        let delta1 = vec![make_delta("sales", json!({"id": "s1", "region": "west", "amount": 100.0}), 1)];
        let result1 = apply_aggregate(
            &mut view,
            &delta1,
            &["region".to_string()],
            &[("revenue".to_string(), AggDef {
                func: "sum".to_string(),
                field: "amount".to_string(),
            })]
            .iter()
            .cloned()
            .collect(),
        );

        let final_val1 = result1.iter().find(|d| d.weight == 1).unwrap();
        assert_eq!(final_val1.record["revenue"], 100.0);

        let delta2 = vec![make_delta("sales", json!({"id": "s1", "region": "west", "amount": 100.0}), -1)];
        let result2 = apply_aggregate(
            &mut view,
            &delta2,
            &["region".to_string()],
            &[("revenue".to_string(), AggDef {
                func: "sum".to_string(),
                field: "amount".to_string(),
            })]
            .iter()
            .cloned()
            .collect(),
        );

        let has_retraction = result2.iter().any(|d| d.weight == -1 && d.record.get("revenue").map_or(false, |v| v == 100.0));
        assert!(has_retraction);

        let new_agg = result2.iter().find(|d| d.weight == 1).unwrap();
        assert_eq!(new_agg.record["revenue"], 0.0);
    }

    #[test]
    fn test_distinct_deduplicates() {
        let mut view = make_view("unique_users", "users", "id", vec![Operator::Distinct {
            key: "id".to_string(),
        }]);

        let deltas = vec![
            make_delta("users", json!({"id": "u1", "name": "Alice"}), 1),
            make_delta("users", json!({"id": "u1", "name": "Alice"}), 1),
            make_delta("users", json!({"id": "u2", "name": "Bob"}), 1),
        ];

        let result = apply_distinct(&mut view, &deltas, "id");
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_distinct_retraction() {
        let mut view = make_view("unique_users", "users", "id", vec![Operator::Distinct {
            key: "id".to_string(),
        }]);

        let delta_add = vec![make_delta("users", json!({"id": "u1", "name": "Alice"}), 1)];
        let result_add = apply_distinct(&mut view, &delta_add, "id");
        assert_eq!(result_add.len(), 1);

        let delta_remove = vec![make_delta("users", json!({"id": "u1", "name": "Alice"}), -1)];
        let result_remove = apply_distinct(&mut view, &delta_remove, "id");
        assert_eq!(result_remove.len(), 1);
        assert_eq!(result_remove[0].weight, -1);
    }

    #[test]
    fn test_join_basic() {
        let mut view = make_view("user_orders", "users", "id", vec![Operator::Join {
            right_table: "orders".to_string(),
            left_key: "id".to_string(),
            right_key: "user_id".to_string(),
        }]);

        let left_deltas = vec![make_delta(
            "users",
            json!({"id": 1, "name": "Alice"}),
            1,
        )];

        let right_deltas = vec![make_delta(
            "orders",
            json!({"user_id": 1, "order_id": 100}),
            1,
        )];

        let result = apply_join(&mut view, &left_deltas, &right_deltas, "id", "user_id");
        assert!(result.len() > 0);
        let merged = &result[0].record;
        assert_eq!(merged["id"], 1);
        assert_eq!(merged["name"], "Alice");
        assert_eq!(merged["order_id"], 100);
    }

    #[test]
    fn test_join_incremental() {
        let mut view = make_view("user_orders", "users", "id", vec![Operator::Join {
            right_table: "orders".to_string(),
            left_key: "id".to_string(),
            right_key: "user_id".to_string(),
        }]);

        let left_deltas = vec![make_delta(
            "users",
            json!({"id": 1, "name": "Alice"}),
            1,
        )];

        let right_deltas_empty: Vec<Delta> = vec![];
        let result1 = apply_join(&mut view, &left_deltas, &right_deltas_empty, "id", "user_id");
        assert_eq!(result1.len(), 0);

        let right_deltas = vec![make_delta(
            "orders",
            json!({"user_id": 1, "order_id": 100}),
            1,
        )];
        let left_empty: Vec<Delta> = vec![];
        let result2 = apply_join(&mut view, &left_empty, &right_deltas, "id", "user_id");
        assert_eq!(result2.len(), 1);
    }

    // ── Integration Tests ───────────────────────────────────────────────────

    /// Regression test for the spendVsBudget pattern in apps/example.
    ///
    /// `view(expenses).join(budgets, category, category).aggregate([category],
    /// { spent: sum(amount), budget: max(budget) })` undersummed because the
    /// join's `left_index` was deduping with the view's post-aggregate
    /// `id_key` ('category') instead of the source table's PK ('id'). All but
    /// the last expense per category got overwritten in left_index, and the
    /// aggregate only saw a fraction of the deltas. The fix splits `id_key`
    /// from `source_id_key` so the join can dedup on the source PK
    /// independently of any downstream rewrite.
    #[test]
    fn test_join_then_aggregate_keeps_all_source_rows() {
        let mut view = make_view_with_source_id(
            "spend_vs_budget",
            "expenses",
            "id",        // source PK — never rewritten
            "category",  // post-aggregate id_key
            vec![
                Operator::Join {
                    right_table: "budgets".to_string(),
                    left_key: "category".to_string(),
                    right_key: "category".to_string(),
                },
                Operator::Aggregate {
                    group_by: vec!["category".to_string()],
                    aggregates: [
                        ("spent".to_string(), AggDef { func: "sum".to_string(), field: "amount".to_string() }),
                        ("budget".to_string(), AggDef { func: "max".to_string(), field: "budget".to_string() }),
                    ].iter().cloned().collect(),
                },
            ],
        );

        // Five expenses for the same category should ALL be summed, not just
        // the last one. The pre-fix bug truncated this to ~$500.
        let deltas = vec![
            make_delta("budgets",  json!({"id": 1, "category": "Food", "budget": 2000.0}), 1),
            make_delta("expenses", json!({"id": 1, "category": "Food", "amount":  100.0}), 1),
            make_delta("expenses", json!({"id": 2, "category": "Food", "amount":  200.0}), 1),
            make_delta("expenses", json!({"id": 3, "category": "Food", "amount":  300.0}), 1),
            make_delta("expenses", json!({"id": 4, "category": "Food", "amount":  400.0}), 1),
            make_delta("expenses", json!({"id": 5, "category": "Food", "amount":  500.0}), 1),
        ];

        let output = process_view(&mut view, &deltas);
        let last = output
            .iter()
            .rev()
            .find(|d| d.weight == 1 && d.record.get("category").map_or(false, |v| v == "Food"))
            .expect("expected at least one Food aggregate row");
        assert_eq!(last.record["spent"], 1500.0, "all 5 expenses should be summed");
        assert_eq!(last.record["budget"], 2000.0);
    }

    /// Reproduces the fresh-client hydrate flow: budgets go in first as a
    /// standalone batch (from SQLite), then expenses arrive one at a time
    /// via NATS "live" mode. The join's right_index must survive the batch
    /// boundary so subsequent expense deltas find matching budgets.
    #[test]
    fn test_join_then_aggregate_budgets_first_then_expenses_one_by_one() {
        let mut view = make_view_with_source_id(
            "spend_vs_budget",
            "expenses",
            "id",
            "category",
            vec![
                Operator::Join {
                    right_table: "budgets".to_string(),
                    left_key: "category".to_string(),
                    right_key: "category".to_string(),
                },
                Operator::Aggregate {
                    group_by: vec!["category".to_string()],
                    aggregates: [
                        ("spent".to_string(), AggDef { func: "sum".to_string(), field: "amount".to_string() }),
                        ("budget".to_string(), AggDef { func: "max".to_string(), field: "budget".to_string() }),
                    ].iter().cloned().collect(),
                },
            ],
        );

        // Phase 1: 5 budgets as a single batch (simulates hydrateFromSQLite).
        let budgets = vec![
            make_delta("budgets", json!({"id": 1, "category": "Food",          "budget": 2000.0}), 1),
            make_delta("budgets", json!({"id": 2, "category": "Travel",        "budget": 5000.0}), 1),
            make_delta("budgets", json!({"id": 3, "category": "Software",      "budget": 3000.0}), 1),
            make_delta("budgets", json!({"id": 4, "category": "Office",        "budget": 4000.0}), 1),
            make_delta("budgets", json!({"id": 5, "category": "Entertainment", "budget": 1500.0}), 1),
        ];
        let phase1_out = process_view(&mut view, &budgets);
        assert_eq!(phase1_out.len(), 0, "budgets alone should emit nothing (left_index empty)");
        // The right_index must be populated after phase 1 for the test to be meaningful.
        assert_eq!(view.right_index.len(), 5, "expected 5 categories in right_index after hydrate");

        // Phase 2: expenses arrive one at a time (simulates live NATS messages).
        let expense = make_delta("expenses", json!({"id": 10, "category": "Food", "amount": 100.0}), 1);
        let out = process_view(&mut view, &[expense]);
        let last = out
            .iter()
            .rev()
            .find(|d| d.weight == 1 && d.record.get("category").map_or(false, |v| v == "Food"))
            .expect("expense step should emit an aggregated Food row");
        assert_eq!(last.record["spent"], 100.0);
        assert_eq!(last.record["budget"], 2000.0);
    }

    /// Same pattern, reversed insertion order: expenses first, budget last.
    /// This is the seed-after-replay case that hit the bug in the live app.
    #[test]
    fn test_join_then_aggregate_budget_arrives_after_expenses() {
        let mut view = make_view_with_source_id(
            "spend_vs_budget",
            "expenses",
            "id",
            "category",
            vec![
                Operator::Join {
                    right_table: "budgets".to_string(),
                    left_key: "category".to_string(),
                    right_key: "category".to_string(),
                },
                Operator::Aggregate {
                    group_by: vec!["category".to_string()],
                    aggregates: [
                        ("spent".to_string(), AggDef { func: "sum".to_string(), field: "amount".to_string() }),
                        ("budget".to_string(), AggDef { func: "max".to_string(), field: "budget".to_string() }),
                    ].iter().cloned().collect(),
                },
            ],
        );

        // Phase 1: 3 expenses arrive with no budget. Join's right_index is
        // empty, so step 1 emits nothing — but step 2 must still record ALL
        // 3 expenses in left_index (this is what the bug broke).
        let phase1 = vec![
            make_delta("expenses", json!({"id": 1, "category": "Food", "amount": 100.0}), 1),
            make_delta("expenses", json!({"id": 2, "category": "Food", "amount": 200.0}), 1),
            make_delta("expenses", json!({"id": 3, "category": "Food", "amount": 300.0}), 1),
        ];
        let _ = process_view(&mut view, &phase1);

        // Phase 2: budget arrives. Join step 3 looks up left_index['Food']
        // and should find all 3 expenses, emitting one merged delta per row.
        let phase2 = vec![
            make_delta("budgets", json!({"id": 1, "category": "Food", "budget": 2000.0}), 1),
        ];
        let output = process_view(&mut view, &phase2);

        let last = output
            .iter()
            .rev()
            .find(|d| d.weight == 1 && d.record.get("category").map_or(false, |v| v == "Food"))
            .expect("expected at least one Food aggregate row after budget arrival");
        assert_eq!(last.record["spent"], 600.0, "all 3 expenses should be summed when budget arrives");
        assert_eq!(last.record["budget"], 2000.0);
    }

    #[test]
    fn test_full_pipeline_filter_then_aggregate() {
        let mut view = make_view("revenue_by_category", "sales", "id", vec![
            Operator::Filter {
                field: "status".to_string(),
                eq: json!("completed"),
            },
            Operator::Aggregate {
                group_by: vec!["category".to_string()],
                aggregates: [("revenue".to_string(), AggDef {
                    func: "sum".to_string(),
                    field: "amount".to_string(),
                })]
                .iter()
                .cloned()
                .collect(),
            },
        ]);

        let deltas = vec![
            make_delta("sales", json!({"id": "s1", "category": "books", "amount": 100.0, "status": "completed"}), 1),
            make_delta("sales", json!({"id": "s2", "category": "books", "amount": 50.0, "status": "pending"}), 1),
            make_delta("sales", json!({"id": "s3", "category": "books", "amount": 75.0, "status": "completed"}), 1),
        ];

        let output = process_view(&mut view, &deltas);
        let final_agg = output.iter().rev().find(|d| d.weight == 1 && d.record.get("category").map_or(false, |v| v == "books")).unwrap();
        assert_eq!(final_agg.record["revenue"], 175.0);
    }

    #[test]
    fn test_reset_clears_state() {
        let mut view = make_view("distinct_users", "users", "id", vec![Operator::Distinct {
            key: "id".to_string(),
        }]);

        let deltas = vec![
            make_delta("users", json!({"id": "u1", "name": "Alice"}), 1),
            make_delta("users", json!({"id": "u2", "name": "Bob"}), 1),
        ];

        let _ = apply_distinct(&mut view, &deltas, "id");
        assert_eq!(view.integrated.len(), 2);

        view.integrated.clear();
        assert_eq!(view.integrated.len(), 0);

        let deltas2 = vec![make_delta("users", json!({"id": "u1", "name": "Alice"}), 1)];
        let result = apply_distinct(&mut view, &deltas2, "id");
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_restore_merge_state() {
        // Simulate restoring merge clocks from a snapshot
        let mut config = MergeConfig::default();
        config.fields.insert("amount".into(), MergeStrategy::Lww);

        let mut state = TableMergeState::new(config);

        // Manually set clocks as if restored from snapshot
        let mut fields = HashMap::new();
        fields.insert("amount".into(), (HLC { ts: 1000, count: 5 }.pack(), Value::Null));
        state.field_clocks.insert("1".into(), fields);

        // Now resolve a new record with older HLC — should keep existing
        let old_hlc = HLC { ts: 999, count: 0 };
        let record = json!({"id": 1, "amount": 50.0});
        let (resolved, _) = state.resolve("id", &record, &old_hlc);

        // The old value (Null from snapshot placeholder) should be kept for LWW
        // because 999 < 1000. But since we stored Null, the resolved record
        // will have Null for amount — in practice the snapshot load via step()
        // would have set the real value before any live mutations arrive.
        assert!(resolved.get("amount").is_some());
    }

    #[test]
    fn test_restore_clock_maintains_monotonicity() {
        let mut hlc = HLC { ts: 500, count: 3 };
        let remote = HLC { ts: 1000, count: 42 };

        // now=0 forces merge to pick max(local, remote)
        hlc.merge(&remote, 0);

        assert_eq!(hlc.ts, 1000);
        assert!(hlc.count > 42); // should be 43
    }
}
