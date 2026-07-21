"""LLM calls for the Understanding Engine — entity/relationship extraction, and
duplicate-candidate detection for entity resolution.

Output is never accepted as free text: every call forces a function tool via
tool_choice, validates the arguments against a Pydantic model, and re-prompts
on a validation failure so the model can self-correct.
"""

import json
import os
import time

import openai
from openai import OpenAI
from pydantic import BaseModel, ValidationError

from .schemas import ExtractionResult

_DEFAULT_MODEL = "gpt-4o"
_MAX_ATTEMPTS = 5
_RATE_LIMIT_MAX_ATTEMPTS = 6
_RATE_LIMIT_BASE_DELAY = 5.0  # seconds; doubles each attempt, capped below
_RATE_LIMIT_MAX_DELAY = 60.0
_CONNECTION_MAX_ATTEMPTS = 4
_CONNECTION_BASE_DELAY = 2.0  # seconds; doubles each attempt, capped below
_CONNECTION_MAX_DELAY = 15.0


def _create_with_rate_limit_retry(client: OpenAI, **kwargs):
    """Two distinct transient-failure classes get their own wait-and-retry
    budgets, separate from _call_tool_with_retry's schema-correction
    attempts — neither is a schema problem:
    - RateLimitError (429): a real, transient capacity signal. Honors a
      Retry-After header when the provider sends one; falls back to
      exponential backoff.
    - APIConnectionError: DNS/network blips — observed in practice right
      after a freshly created Azure endpoint, before its routing has fully
      propagated. Short backoff, since these normally clear in seconds.
    Either budget exhausted still raises, so a genuinely stuck quota or a
    real outage fails loudly rather than hanging or being silently
    swallowed."""
    for attempt in range(_RATE_LIMIT_MAX_ATTEMPTS):
        try:
            return _create_with_connection_retry(client, **kwargs)
        except openai.RateLimitError as exc:
            if attempt == _RATE_LIMIT_MAX_ATTEMPTS - 1:
                raise
            retry_after = exc.response.headers.get("retry-after") if exc.response is not None else None
            if retry_after is not None:
                delay = float(retry_after)
            else:
                delay = min(_RATE_LIMIT_MAX_DELAY, _RATE_LIMIT_BASE_DELAY * (2 ** attempt))
            print(
                f"[llm_extraction] rate limited (attempt {attempt + 1}/{_RATE_LIMIT_MAX_ATTEMPTS}), "
                f"waiting {delay:.0f}s before retrying: {exc}"
            )
            time.sleep(delay)


def _create_with_connection_retry(client: OpenAI, **kwargs):
    for attempt in range(_CONNECTION_MAX_ATTEMPTS):
        try:
            return client.chat.completions.create(**kwargs)
        except openai.APIConnectionError as exc:
            if attempt == _CONNECTION_MAX_ATTEMPTS - 1:
                raise
            delay = min(_CONNECTION_MAX_DELAY, _CONNECTION_BASE_DELAY * (2 ** attempt))
            print(
                f"[llm_extraction] connection error (attempt {attempt + 1}/{_CONNECTION_MAX_ATTEMPTS}), "
                f"waiting {delay:.0f}s before retrying: {exc}"
            )
            time.sleep(delay)

_SYSTEM_PROMPT = """You are extracting factory-process entities and relationships from one \
uploaded source document at a time, for a manufacturing understanding pipeline.

Rules:
- entity_type must be one of: stage, asset, signal, role, department, objective.
- Every entity needs a stable `id` (short, slug-like, unique within this source).
- Every `signal` entity MUST have attributes.perspective set to one of: mechanical, electrical, \
process. Use mechanical for physical/moving-part signals, electrical for sensor/motor/PLC signals, \
process for the transformed parameter itself (temperature, pressure, throughput, etc.).
- A tabular source can be one of two different things — tell them apart carefully:
  (a) a data log: one row per timestamp/reading, with a column of actual numeric/measured values
      for the signal over time.
  (b) a tag catalog: one row per signal describing it (an ID, a description, a unit) but containing
      no actual readings at all — just metadata about a signal that some other, separate system holds
      the real data for.
  Only set attributes.source_reference to the value column's exact header when the source is case (a) —
  that is what lets a later stage pull real recorded values back out of this file. If the source is case
  (b), or the signal is named only in free text (SOP/PDF), leave source_reference null: the signal is
  known to exist, but this file is not where its data values live. Do not point source_reference at an
  identifier or description column just because it is the closest thing available — null is the honest
  answer when no value column exists.
- `source` on every entity/relationship must be exactly the source file name given to you.
- `confidence` is your own extraction confidence (0-1), not a business metric.
- relationship_type must be one of: precedes, part_of, measures, produces, consumes, reports_to.
- Do not invent entities the source doesn't support.
- Do not resolve ambiguity yourself: if a source refers to something loosely (e.g. "the cooling \
belt") extract it as its own entity under that name, verbatim. A later pipeline stage handles \
matching it against other entities — that is not your job.
- You may be given a list of entities already known from other sources processed earlier in this
  same project. Each source is still extracted independently — do not skip creating an entity for
  something this source describes just because something similar is already known; that equivalence
  judgment belongs to a later resolution stage, not you. The known list exists for ONE narrower
  purpose: if this source describes a relationship between something here and something that is
  unambiguously one of those already-known entities (e.g. a data log's column is clearly a reading
  from an already-known asset named elsewhere), set that side of the relationship's from_id/to_id to
  the known entity's exact id rather than leaving the relationship out for lack of a target in this
  file alone. If you are not confident it is the same thing, do not use the known id — leave the
  relationship out rather than guess.
- The no-skip rule above matters MOST for data logs (case (a) sources): if this source holds actual
  recorded values for a signal, you MUST create a signal entity here with source_reference set to the
  value column's header — even when a signal of the same or similar name is already in the known list.
  A known entity extracted from a tag catalog or SOP carries no source_reference, because that file had
  no values; THIS extraction is the only place the column pointer can ever come from, and the later
  resolution stage will merge the two entities without losing it. Skipping the entity here permanently
  disconnects the signal from its data.
- Call the tool exactly once with the full extraction for this source."""

_DEDUP_SYSTEM_PROMPT = """You are looking at a list of entities of the same type, extracted from \
different documents describing one factory's process, machines, and sensors. Some may be the SAME \
real-world thing, named or described differently across documents — a tag code like "FCE-03" is a \
common abbreviation for a machine named "Furnace 3"; a signal name like "FCE-03_TEMP" commonly \
corresponds to a plain-language description like "Furnace chamber temperature" for the same physical \
sensor. Use general manufacturing/engineering naming conventions to recognize these — abbreviations, \
tag-code prefixes, unit/equipment numbering, and paraphrased descriptions of the same parameter.

Your only job: list every PAIR of entities below that plausibly refer to the same real-world thing.

Rules:
- You are not deciding for certain — a human confirms or rejects every pair you list. This is a
  candidate list, not a merge decision.
- If genuinely unsure whether two entities are the same, include the pair anyway with your reasoning.
  It is fine to propose a pair that turns out to be wrong; it is not fine to silently omit a real
  match because you were not fully confident.
- Do not pair two entities just because they mention the same machine if they are clearly different
  parameters on it (e.g. a temperature reading and a vibration reading on the same furnace are
  different signals, not the same one, even though both name the furnace).
- Every pair needs a short reasoning string explaining why you think they might be the same thing.
- In your top-level reasoning field, you MUST work through the list exhaustively before deciding: for
  every entity whose name is a short tag/code, explicitly check it against every entity whose name is a
  longer plain-language description, and vice versa — that pairing (code vs description of the same
  parameter) is the single most common real match in this data and is easy to miss if you only compare
  entities that already look similar at a glance. Only after this explicit pass, list the pairs found.
- Call the tool exactly once with every candidate pair found. If there are none, call it with an
  empty list — do not skip calling it."""


class CandidatePair(BaseModel):
    reasoning: str
    id_a: str
    id_b: str


class CandidatePairsResult(BaseModel):
    # reasoning first: same field-order fix as RelevanceDecision/TaskDecision/
    # SchedulingInputs — a structured-output model fills fields in declaration
    # order, so without a reasoning field ahead of `pairs`, it can (and was
    # observed to) commit to an empty pairs list before ever comparing
    # entities pairwise. Forcing the exhaustive comparison into a field that
    # must be written first is what makes it actually happen.
    reasoning: str
    pairs: list[CandidatePair]


def _client() -> OpenAI:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    # OPENAI_BASE_URL supports OpenAI-compatible endpoints, e.g. Azure OpenAI's
    # /openai/v1 surface, where the model name is the Azure deployment name.
    base_url = os.environ.get("OPENAI_BASE_URL")
    return OpenAI(api_key=api_key, base_url=base_url)


def _model_name() -> str:
    return os.environ.get("OPENAI_MODEL", _DEFAULT_MODEL)


def _unwrap_if_nested(arguments: dict, result_model: type[BaseModel]) -> dict:
    """Some OpenAI-compatible providers wrap the real tool arguments one level
    deeper, under a single key matching the result type's own name — observed:
    {"extraction_result": {"entities": [...], "relationships": [...]}} instead
    of the flat shape the schema asks for. This is a wire-format quirk, not a
    content mistake, so the retry-with-error-message loop below can't talk the
    model out of it (it repeats the same wrapping every attempt). Only unwrap
    when the top level has none of the expected fields but has exactly one key
    whose value is a dict that does — never touches an already-correct or
    partially-correct response."""
    expected = set(result_model.model_fields.keys())
    if expected & arguments.keys():
        return arguments
    if len(arguments) == 1:
        (only_value,) = arguments.values()
        if isinstance(only_value, dict) and expected & only_value.keys():
            return only_value
    return arguments


def _call_tool_with_retry(
    tool_name: str, tool_description: str, result_model: type[BaseModel], messages: list
) -> BaseModel:
    client = _client()
    tools = [
        {
            "type": "function",
            "function": {
                "name": tool_name,
                "description": tool_description,
                "parameters": result_model.model_json_schema(),
            },
        }
    ]

    last_error: str | None = None
    for _attempt in range(_MAX_ATTEMPTS):
        # "required" instead of naming the tool: we always pass exactly one tool, so
        # the two are equivalent — but some OpenAI-compatible providers (Azure's
        # DeepSeek endpoint) abort on the named form while honoring "required".
        response = _create_with_rate_limit_retry(
            client,
            model=_model_name(),
            tools=tools,
            tool_choice="required",
            messages=messages,
        )
        message = response.choices[0].message
        tool_calls = message.tool_calls or []
        if not tool_calls:
            last_error = "model did not call the required tool"
            messages.append({"role": "assistant", "content": message.content or ""})
            messages.append(
                {"role": "user", "content": f"You must call the {tool_name} tool. Try again."}
            )
            continue

        tool_call = tool_calls[0]
        try:
            arguments = json.loads(tool_call.function.arguments)
            unwrapped = _unwrap_if_nested(arguments, result_model)
            if unwrapped is not arguments:
                print(f"[llm_extraction] unwrapped a nested '{list(arguments.keys())[0]}' wrapper around the tool arguments")
            return result_model.model_validate(unwrapped)
        except (json.JSONDecodeError, ValidationError) as exc:
            last_error = str(exc)
            messages.append(message)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": f"Schema validation failed: {exc}\n"
                    "Call the tool again with corrected JSON, fixing exactly this error — "
                    "every field the error names must be present and non-null. If a signal's "
                    "perspective is unclear because it isn't a physical sensor reading (e.g. it "
                    "is a business/order data column like a quantity, date, or id), use 'process' "
                    "— that is the correct value for a non-physical parameter, not an omission.",
                }
            )

    raise ValueError(f"tool call '{tool_name}' failed schema validation after {_MAX_ATTEMPTS} attempts: {last_error}")


def extract_from_source(
    source_name: str, source_text: str, known_entities: list[dict] | None = None
) -> ExtractionResult:
    known_block = ""
    if known_entities:
        lines = "\n".join(
            f"- id={e['id']!r}, type={e['entity_type']}, name={e['name']!r}"
            + (f", notes={e['notes']!r}" if e.get("notes") else "")
            for e in known_entities
        )
        known_block = (
            "\n\nEntities already known from other sources processed earlier in this project "
            f"(see the rule above on when to reference one):\n{lines}"
        )

    messages: list = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"Source file name: {source_name}\n\nSource content:\n{source_text}{known_block}",
        },
    ]
    result = _call_tool_with_retry(
        "record_extraction", "Record the extracted entities and relationships for this source.",
        ExtractionResult, messages,
    )
    return result  # type: ignore[return-value]


def find_candidate_duplicate_pairs(entity_type: str, entities: list[dict]) -> list[CandidatePair]:
    """entities: list of {id, name, notes, source}. Returns candidate pairs for a human to confirm
    or reject — reasoning replaces a bare similarity score because it is what a reviewer can actually
    act on. Never merges anything on its own."""
    if len(entities) < 2:
        return []

    listing = "\n".join(
        f"- id={e['id']!r}, name={e['name']!r}, notes={e['notes']!r}, source={e['source']!r}"
        for e in entities
    )
    messages: list = [
        {"role": "system", "content": _DEDUP_SYSTEM_PROMPT},
        {"role": "user", "content": f"Entity type: {entity_type}\n\nEntities:\n{listing}"},
    ]
    result = _call_tool_with_retry(
        "record_candidate_pairs", "Record every candidate duplicate pair found.",
        CandidatePairsResult, messages,
    )
    return result.pairs  # type: ignore[union-attr]
