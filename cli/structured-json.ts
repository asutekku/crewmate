import {
  COMMITMENT_MODES,
  CORRECTION_TYPES,
  DEPENDENCY_EFFECTS,
  PRIORITIES,
  STRUCTURED_ACT_TYPES,
  type ObligationCondition,
  type StructuredActInput,
  type StructuredDependencyInput,
} from "../core/obligations.ts";
import { failure, success, type Result } from "./result.ts";

export interface StructuredFileInput {
  readonly acts: StructuredActInput[];
  readonly dependencies?: StructuredDependencyInput[];
  readonly idempotencyKey?: string;
}

type ObjectValue = Record<string, unknown>;

function isObjectValue(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, label: string): Result<ObjectValue> {
  return isObjectValue(value)
    ? success(value)
    : failure(`${label} must be an object`);
}

function allowed(
  value: ObjectValue,
  keys: readonly string[],
  label: string,
): Result<void> {
  const unexpected = Object.keys(value).find((key) => !keys.includes(key));
  // NAMES THE PATH AND THE ALTERNATIVES, because the common failure is a field
  // in the right vocabulary at the wrong DEPTH: `{"text": …}` at the top level
  // reported "unsupported field text" when `text` is very much supported --
  // inside `acts[]`. Measured 2026-08-05: two consecutive failures on the one
  // verb designed for structured use, before a correct call.
  return unexpected
    ? failure(
        `${label} contains unsupported field ${unexpected} — ` +
          `${label} accepts ${keys.join(", ")}`,
      )
    : success(undefined);
}

function propagateFailure<T>(result: Result<unknown>): Result<T> {
  return failure(
    result.ok ? "decoder validation invariant failed" : result.error,
  );
}

function requiredString(
  value: ObjectValue,
  key: string,
  label: string,
): Result<string> {
  const field = value[key];
  return typeof field === "string" && field.trim()
    ? success(field)
    : failure(`${label}.${key} must be a non-empty string`);
}

function optionalString(
  value: ObjectValue,
  key: string,
  label: string,
): Result<string | undefined> {
  const field = value[key];
  return field === undefined
    ? success(undefined)
    : typeof field === "string" && field.trim()
      ? success(field)
      : failure(`${label}.${key} must be a non-empty string when present`);
}

function optionalBoolean(
  value: ObjectValue,
  key: string,
  label: string,
): Result<boolean | undefined> {
  const field = value[key];
  return field === undefined
    ? success(undefined)
    : typeof field === "boolean"
      ? success(field)
      : failure(`${label}.${key} must be boolean when present`);
}

function stringArray(value: unknown, label: string): Result<string[]> {
  if (!Array.isArray(value)) return failure(`${label} must be an array`);
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim())
      return failure(`${label}[${index}] must be a non-empty string`);
    result.push(item);
  }
  return success(result);
}

function optionalStringArray(
  value: ObjectValue,
  key: string,
  label: string,
): Result<string[] | undefined> {
  return value[key] === undefined
    ? success(undefined)
    : stringArray(value[key], `${label}.${key}`);
}

function enumValue<const T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): Result<T> {
  const found =
    typeof value === "string"
      ? values.find((item) => item === value)
      : undefined;
  return found === undefined
    ? failure(`${label} must be one of: ${values.join(", ")}`)
    : success(found);
}

function decodeCondition(
  value: unknown,
  label: string,
): Result<ObligationCondition | undefined> {
  if (value === undefined) return success(undefined);
  const decoded = object(value, label);
  if (!decoded.ok) return decoded;
  const text = requiredString(decoded.value, "text", label);
  if (!text.ok) return text;
  const handling = enumValue(
    decoded.value["handling"],
    ["automatic", "resurface_on_related_event", "manual"] as const,
    `${label}.handling`,
  );
  if (!handling.ok) return handling;
  if (handling.value === "manual") {
    const fields = allowed(decoded.value, ["text", "handling"], label);
    return fields.ok
      ? success({ text: text.value, handling: "manual" })
      : fields;
  }
  if (handling.value === "resurface_on_related_event") {
    const fields = allowed(decoded.value, ["text", "handling", "event"], label);
    if (!fields.ok) return fields;
    const event = object(decoded.value["event"], `${label}.event`);
    if (!event.ok) return event;
    const kind = enumValue(
      event.value["kind"],
      ["work_updated", "obligation_updated"] as const,
      `${label}.event.kind`,
    );
    if (!kind.ok) return kind;
    if (kind.value === "work_updated") {
      const workId = requiredString(event.value, "workId", `${label}.event`);
      const valid = allowed(event.value, ["kind", "workId"], `${label}.event`);
      return workId.ok && valid.ok
        ? success({
            text: text.value,
            handling: "resurface_on_related_event",
            event: { kind: "work_updated", workId: workId.value },
          })
        : workId.ok
          ? propagateFailure(valid)
          : workId;
    }
    const obligationId = requiredString(
      event.value,
      "obligationId",
      `${label}.event`,
    );
    const valid = allowed(
      event.value,
      ["kind", "obligationId"],
      `${label}.event`,
    );
    return obligationId.ok && valid.ok
      ? success({
          text: text.value,
          handling: "resurface_on_related_event",
          event: {
            kind: "obligation_updated",
            obligationId: obligationId.value,
          },
        })
      : obligationId.ok
        ? propagateFailure(valid)
        : obligationId;
  }
  const fields = allowed(decoded.value, ["text", "handling", "trigger"], label);
  if (!fields.ok) return fields;
  const trigger = object(decoded.value["trigger"], `${label}.trigger`);
  if (!trigger.ok) return trigger;
  const kind = enumValue(
    trigger.value["kind"],
    [
      "commit_reachable",
      "work_completed",
      "work_step_completed",
      "obligation_resolved",
    ] as const,
    `${label}.trigger.kind`,
  );
  if (!kind.ok) return kind;
  if (kind.value === "commit_reachable") {
    const commitSha = requiredString(
      trigger.value,
      "commitSha",
      `${label}.trigger`,
    );
    const branch = requiredString(trigger.value, "branch", `${label}.trigger`);
    const valid = allowed(
      trigger.value,
      ["kind", "commitSha", "branch"],
      `${label}.trigger`,
    );
    return commitSha.ok && branch.ok && valid.ok
      ? success({
          text: text.value,
          handling: "automatic",
          trigger: {
            kind: "commit_reachable",
            commitSha: commitSha.value,
            branch: branch.value,
          },
        })
      : !commitSha.ok
        ? commitSha
        : !branch.ok
          ? branch
          : propagateFailure(valid);
  }
  if (kind.value === "work_completed") {
    const workId = requiredString(trigger.value, "workId", `${label}.trigger`);
    const valid = allowed(
      trigger.value,
      ["kind", "workId"],
      `${label}.trigger`,
    );
    return workId.ok && valid.ok
      ? success({
          text: text.value,
          handling: "automatic",
          trigger: { kind: "work_completed", workId: workId.value },
        })
      : workId.ok
        ? propagateFailure(valid)
        : workId;
  }
  if (kind.value === "work_step_completed") {
    const workId = requiredString(trigger.value, "workId", `${label}.trigger`);
    const step = trigger.value["step"];
    if (!workId.ok) return workId;
    if (typeof step !== "number" || !Number.isSafeInteger(step) || step < 1)
      return failure(`${label}.trigger.step must be a positive safe integer`);
    const valid = allowed(
      trigger.value,
      ["kind", "workId", "step"],
      `${label}.trigger`,
    );
    return valid.ok
      ? success({
          text: text.value,
          handling: "automatic",
          trigger: { kind: "work_step_completed", workId: workId.value, step },
        })
      : propagateFailure(valid);
  }
  const obligationId = requiredString(
    trigger.value,
    "obligationId",
    `${label}.trigger`,
  );
  const resolutionKey = optionalString(
    trigger.value,
    "resolutionKey",
    `${label}.trigger`,
  );
  const valid = allowed(
    trigger.value,
    ["kind", "obligationId", "resolutionKey"],
    `${label}.trigger`,
  );
  return obligationId.ok && resolutionKey.ok && valid.ok
    ? success({
        text: text.value,
        handling: "automatic",
        trigger: {
          kind: "obligation_resolved",
          obligationId: obligationId.value,
          ...(resolutionKey.value
            ? { resolutionKey: resolutionKey.value }
            : {}),
        },
      })
    : !obligationId.ok
      ? obligationId
      : !resolutionKey.ok
        ? resolutionKey
        : propagateFailure(valid);
}

const COMMON_ACT_FIELDS = [
  "key",
  "type",
  "text",
  "condition",
  "priority",
  "resolutionKeys",
] as const;

function decodeAct(value: unknown, index: number): Result<StructuredActInput> {
  const label = `acts[${index}]`;
  const decoded = object(value, label);
  if (!decoded.ok) return decoded;
  const type = enumValue(
    decoded.value["type"],
    STRUCTURED_ACT_TYPES,
    `${label}.type`,
  );
  const key = requiredString(decoded.value, "key", label);
  const text = requiredString(decoded.value, "text", label);
  const condition = decodeCondition(
    decoded.value["condition"],
    `${label}.condition`,
  );
  const priority =
    decoded.value["priority"] === undefined
      ? success(undefined)
      : enumValue(decoded.value["priority"], PRIORITIES, `${label}.priority`);
  const resolutionKeys = optionalStringArray(
    decoded.value,
    "resolutionKeys",
    label,
  );
  if (!type.ok) return type;
  if (!key.ok) return key;
  if (!text.ok) return text;
  if (!condition.ok) return condition;
  if (!priority.ok) return priority;
  if (!resolutionKeys.ok) return resolutionKeys;
  const common = {
    key: key.value,
    text: text.value,
    ...(condition.value ? { condition: condition.value } : {}),
    ...(priority.value ? { priority: priority.value } : {}),
    ...(resolutionKeys.value ? { resolutionKeys: resolutionKeys.value } : {}),
  };
  switch (type.value) {
    case "question": {
      const valid = allowed(decoded.value, COMMON_ACT_FIELDS, label);
      return valid.ok
        ? success({ ...common, type: "question" })
        : propagateFailure(valid);
    }
    case "request": {
      const unassigned = optionalBoolean(decoded.value, "unassigned", label);
      const valid = allowed(
        decoded.value,
        [...COMMON_ACT_FIELDS, "unassigned"],
        label,
      );
      return unassigned.ok && valid.ok
        ? success({
            ...common,
            type: "request",
            ...(unassigned.value === undefined
              ? {}
              : { unassigned: unassigned.value }),
          })
        : unassigned.ok
          ? propagateFailure(valid)
          : unassigned;
    }
    case "promise": {
      const mode = enumValue(
        decoded.value["mode"],
        COMMITMENT_MODES,
        `${label}.mode`,
      );
      const releaseBoundary = decodeCondition(
        decoded.value["releaseBoundary"],
        `${label}.releaseBoundary`,
      );
      const valid = allowed(
        decoded.value,
        [...COMMON_ACT_FIELDS, "mode", "releaseBoundary"],
        label,
      );
      return mode.ok && releaseBoundary.ok && valid.ok
        ? success({
            ...common,
            type: "promise",
            mode: mode.value,
            ...(releaseBoundary.value
              ? { releaseBoundary: releaseBoundary.value }
              : {}),
          })
        : !mode.ok
          ? mode
          : releaseBoundary.ok
            ? propagateFailure(valid)
            : releaseBoundary;
    }
    case "handoff": {
      const subject = requiredString(decoded.value, "subject", label);
      const valid = allowed(
        decoded.value,
        [...COMMON_ACT_FIELDS, "subject"],
        label,
      );
      return subject.ok && valid.ok
        ? success({ ...common, type: "handoff", subject: subject.value })
        : subject.ok
          ? propagateFailure(valid)
          : subject;
    }
    case "grant": {
      const scopeText = requiredString(decoded.value, "scopeText", label);
      const releaseBoundary = decodeCondition(
        decoded.value["releaseBoundary"],
        `${label}.releaseBoundary`,
      );
      const valid = allowed(
        decoded.value,
        [...COMMON_ACT_FIELDS, "scopeText", "releaseBoundary"],
        label,
      );
      return scopeText.ok && releaseBoundary.ok && valid.ok
        ? success({
            ...common,
            type: "grant",
            scopeText: scopeText.value,
            ...(releaseBoundary.value
              ? { releaseBoundary: releaseBoundary.value }
              : {}),
          })
        : !scopeText.ok
          ? scopeText
          : releaseBoundary.ok
            ? propagateFailure(valid)
            : releaseBoundary;
    }
    case "correction": {
      const correctionType = enumValue(
        decoded.value["correctionType"],
        CORRECTION_TYPES,
        `${label}.correctionType`,
      );
      const contradictsActId = optionalString(
        decoded.value,
        "contradictsActId",
        label,
      );
      const valid = allowed(
        decoded.value,
        [...COMMON_ACT_FIELDS, "correctionType", "contradictsActId"],
        label,
      );
      return correctionType.ok && contradictsActId.ok && valid.ok
        ? success({
            ...common,
            type: "correction",
            correctionType: correctionType.value,
            ...(contradictsActId.value
              ? { contradictsActId: contradictsActId.value }
              : {}),
          })
        : !correctionType.ok
          ? correctionType
          : contradictsActId.ok
            ? propagateFailure(valid)
            : contradictsActId;
    }
    case "hazard": {
      const subject = requiredString(decoded.value, "subject", label);
      const relatedActKeys = optionalStringArray(
        decoded.value,
        "relatedActKeys",
        label,
      );
      const valid = allowed(
        decoded.value,
        [...COMMON_ACT_FIELDS, "subject", "relatedActKeys"],
        label,
      );
      return subject.ok && relatedActKeys.ok && valid.ok
        ? success({
            ...common,
            type: "hazard",
            subject: subject.value,
            ...(relatedActKeys.value
              ? { relatedActKeys: relatedActKeys.value }
              : {}),
          })
        : !subject.ok
          ? subject
          : relatedActKeys.ok
            ? propagateFailure(valid)
            : relatedActKeys;
    }
  }
}

function decodeDependency(
  value: unknown,
  index: number,
): Result<StructuredDependencyInput> {
  const label = `dependencies[${index}]`;
  const decoded = object(value, label);
  if (!decoded.ok) return decoded;
  const valid = allowed(
    decoded.value,
    ["sourceKey", "resolutionKey", "targetKey", "effect"],
    label,
  );
  const sourceKey = requiredString(decoded.value, "sourceKey", label);
  const targetKey = requiredString(decoded.value, "targetKey", label);
  const resolutionKey = optionalString(decoded.value, "resolutionKey", label);
  const effect = enumValue(
    decoded.value["effect"],
    DEPENDENCY_EFFECTS,
    `${label}.effect`,
  );
  if (!valid.ok) return valid;
  if (!sourceKey.ok) return sourceKey;
  if (!targetKey.ok) return targetKey;
  if (!resolutionKey.ok) return resolutionKey;
  if (!effect.ok) return effect;
  return success({
    sourceKey: sourceKey.value,
    targetKey: targetKey.value,
    effect: effect.value,
    ...(resolutionKey.value ? { resolutionKey: resolutionKey.value } : {}),
  });
}

export function decodeStructuredFile(
  value: unknown,
): Result<StructuredFileInput> {
  const decoded = object(value, "JSON");
  if (!decoded.ok) return decoded;
  const valid = allowed(
    decoded.value,
    ["acts", "dependencies", "idempotencyKey"],
    "JSON",
  );
  if (!valid.ok) return valid;
  if (!Array.isArray(decoded.value["acts"]))
    return failure("JSON.acts must be an array");
  if (decoded.value["acts"].length === 0)
    return failure("JSON.acts must not be empty");
  const acts: StructuredActInput[] = [];
  for (const [index, value] of decoded.value["acts"].entries()) {
    const act = decodeAct(value, index);
    if (!act.ok) return act;
    acts.push(act.value);
  }
  let dependencies: StructuredDependencyInput[] | undefined;
  if (decoded.value["dependencies"] !== undefined) {
    if (!Array.isArray(decoded.value["dependencies"]))
      return failure("JSON.dependencies must be an array");
    dependencies = [];
    for (const [index, value] of decoded.value["dependencies"].entries()) {
      const dependency = decodeDependency(value, index);
      if (!dependency.ok) return dependency;
      dependencies.push(dependency.value);
    }
  }
  const idempotencyKey = optionalString(
    decoded.value,
    "idempotencyKey",
    "JSON",
  );
  if (!idempotencyKey.ok) return idempotencyKey;
  return success({
    acts,
    ...(dependencies ? { dependencies } : {}),
    ...(idempotencyKey.value ? { idempotencyKey: idempotencyKey.value } : {}),
  });
}
