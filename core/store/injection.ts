import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { featureForCandidate, isFeatureId } from "../features.ts";
import type {
  FeatureStage,
  FeatureSurface,
  InjectionLedgerRow,
  InjectionOmitted,
  InjectionShown,
} from "./types.ts";
import type { FeatureId } from "../features.ts";

export interface FeatureEventInput {
  readonly sessionId: string;
  readonly feature: FeatureId;
  readonly stage: FeatureStage;
  readonly surface: FeatureSurface;
  readonly opportunityId: string;
  readonly sourceKey?: string;
  readonly deliveryId?: number;
  readonly nowMs: number;
  readonly codeVersion?: string;
  readonly featureSetVersion?: number;
  readonly eventId?: string;
}

/** Exposure suppression, omission debt, and the append-only delivery ledger. */
export class InjectionStore {
  constructor(private readonly db: Database) {}

  setCodeVersion(
    sessionId: string,
    version: string,
    features: readonly string[],
    nowMs: number,
    featureSetVersion: number,
  ): void {
    this.db.query(`UPDATE sessions SET code_version = ? WHERE session_id = ?`).run(version, sessionId);
    for (const feature of features) {
      if (!isFeatureId(feature)) continue;
      this.recordFeatureEvent({
        sessionId, feature, stage: "availability", surface: "build",
        opportunityId: sessionId, sourceKey: version, nowMs,
        codeVersion: version, featureSetVersion,
      });
    }
  }

  recordFeatureEvent(input: FeatureEventInput): void {
    if (!input.sessionId.trim() || !input.opportunityId.trim() || !isFeatureId(input.feature)) {
      throw new Error("invalid feature observation identity");
    }
    const allowed = input.stage === "availability"
      ? input.surface === "build"
      : input.stage === "exposure"
        ? ["actionable", "context", "help"].includes(input.surface)
        : ["cli", "api"].includes(input.surface);
    if (!allowed) throw new Error("feature stage and surface do not match");
    const deliveryId = input.deliveryId ?? 0;
    if (["actionable", "context"].includes(input.surface)) {
      const delivery = this.db.query(
        `SELECT 1 FROM injection_ledger WHERE session_id = ? AND delivery_id = ?`,
      ).get(input.sessionId, deliveryId);
      if (deliveryId <= 0 || !delivery) throw new Error("injection exposure requires its delivery");
    } else if (deliveryId !== 0) {
      throw new Error("only injection exposure may reference a delivery");
    }
    this.db.query(
      `INSERT OR IGNORE INTO feature_events
         (event_id,session_id,feature,stage,surface,opportunity_id,source_key,
          delivery_id,ts_ms,code_version,feature_set_version)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.eventId ?? randomUUID(), input.sessionId, input.feature, input.stage,
      input.surface, input.opportunityId, input.sourceKey ?? "", deliveryId,
      input.nowMs, input.codeVersion ?? "", input.featureSetVersion ?? 0,
    );
  }

  codeVersions(): Map<string, string> {
    const rows = this.db.query(`SELECT session_id, code_version FROM sessions`).all() as Array<
      Record<string, string>
    >;
    return new Map(rows.map((row) => [String(row["session_id"]), String(row["code_version"] ?? "")]));
  }

  exposures(sessionId: string): Map<string, string> {
    const rows = this.db.query(
      `SELECT dedupe_key AS key, state_ver AS version
         FROM injection_exposures WHERE session_id = ?`,
    ).all(sessionId) as Array<{ key: string; version: string }>;
    return new Map(rows.map((row) => [row.key, row.version]));
  }

  record(
    sessionId: string,
    result: {
      readonly shown: ReadonlyArray<InjectionShown>;
      readonly omitted: ReadonlyArray<InjectionOmitted>;
      readonly nowMs: number;
      readonly clearFirst?: boolean;
    },
  ): void {
    const nextDeliveryId = this.db.query(
      `SELECT COALESCE(MAX(delivery_id), 0) + 1 AS id FROM injection_ledger`,
    );
    const expose = this.db.query(
      `INSERT OR REPLACE INTO injection_exposures
         (session_id, dedupe_key, state_ver, ts_ms) VALUES (?, ?, ?, ?)`,
    );
    const clearExposures = this.db.query(`DELETE FROM injection_exposures WHERE session_id = ?`);
    const clearOmissions = this.db.query(`DELETE FROM injection_omissions WHERE session_id = ?`);
    const owe = this.db.query(
      `INSERT OR REPLACE INTO injection_omissions
         (session_id, key, text, reason, state_ver, ts_ms) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const log = this.db.query(
      `INSERT INTO injection_ledger
         (session_id, delivery_id, ts_ms, key, dedupe_key, state_ver,
          outcome, form, reason, priority, chars) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const record = this.db.transaction(() => {
      const deliveryId = (nextDeliveryId.get() as { id: number }).id;
      if (result.clearFirst === true) clearExposures.run(sessionId);
      for (const shown of result.shown) {
        expose.run(sessionId, shown.dedupeKey, shown.stateVersion, result.nowMs);
        log.run(
          sessionId, deliveryId, result.nowMs, shown.key, shown.dedupeKey,
          shown.stateVersion, "selected", shown.form, "", shown.priority, shown.chars,
        );
        const feature = featureForCandidate(shown.key);
        if (feature) {
          this.recordFeatureEvent({
            sessionId, feature, stage: "exposure",
            surface: shown.actionable === true ? "actionable" : "context",
            opportunityId: sessionId, sourceKey: `${shown.key}:${shown.stateVersion}`,
            deliveryId, nowMs: result.nowMs,
          });
        }
      }
      clearOmissions.run(sessionId);
      for (const omitted of result.omitted) {
        log.run(
          sessionId, deliveryId, result.nowMs, omitted.key, omitted.dedupeKey,
          omitted.stateVersion, "omitted", "", omitted.reason, omitted.priority,
          omitted.text.length,
        );
        if (omitted.reason === "no room" && omitted.actionable) {
          owe.run(
            sessionId, omitted.key, omitted.text, omitted.reason,
            omitted.stateVersion, result.nowMs,
          );
        }
      }
    });
    record.immediate();
  }

  history(sessionId: string, limit: number): InjectionLedgerRow[] {
    return this.db.query(
      `SELECT delivery_id AS deliveryId, ts_ms AS tsMs, key, dedupe_key AS dedupeKey,
              state_ver AS stateVersion, outcome, form, reason, priority, chars
         FROM injection_ledger WHERE session_id = ?
        ORDER BY delivery_id DESC, priority DESC, key ASC LIMIT ?`,
    ).all(sessionId, limit) as InjectionLedgerRow[];
  }

  clearExposures(sessionId: string): void {
    this.db.query(`DELETE FROM injection_exposures WHERE session_id = ?`).run(sessionId);
  }

  prune(nowMs: number, keepMs: number): void {
    const cutoff = nowMs - keepMs;
    this.db.query(`DELETE FROM injection_exposures WHERE ts_ms < ?`).run(cutoff);
    this.db.query(`DELETE FROM injection_omissions WHERE ts_ms < ?`).run(cutoff);
    this.db.query(`DELETE FROM injection_ledger WHERE ts_ms < ?`).run(cutoff);
  }

  omissions(sessionId: string): Array<{
    key: string; text: string; reason: string; stateVersion: string;
  }> {
    return this.db.query(
      `SELECT key, text, reason, state_ver AS stateVersion FROM injection_omissions
        WHERE session_id = ? ORDER BY ts_ms ASC, key ASC`,
    ).all(sessionId) as Array<{
      key: string; text: string; reason: string; stateVersion: string;
    }>;
  }
}
