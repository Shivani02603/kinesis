"""Entity/relationship schema for the Understanding Engine.

Do not remove required fields or loosen the signal->perspective requirement;
downstream feature templates depend on every signal carrying a perspective tag.
"""

from enum import Enum

from pydantic import BaseModel, Field, model_validator


class EntityType(str, Enum):
    STAGE = "stage"
    ASSET = "asset"
    SIGNAL = "signal"
    ROLE = "role"
    DEPARTMENT = "department"
    OBJECTIVE = "objective"


class Perspective(str, Enum):
    MECHANICAL = "mechanical"
    ELECTRICAL = "electrical"
    PROCESS = "process"


class RelationshipType(str, Enum):
    PRECEDES = "precedes"
    PART_OF = "part_of"
    MEASURES = "measures"
    PRODUCES = "produces"
    CONSUMES = "consumes"
    REPORTS_TO = "reports_to"


class EntityAttributes(BaseModel):
    # Required-but-nullable, NOT optional-with-default: an optional field is
    # left out of the tool schema's "required" list, and structured-output
    # models (DeepSeek observed doing this) silently omit non-required fields.
    # Requiring the key forces the model to write a value or an explicit null
    # for every entity — and for signals the validator below rejects null.
    perspective: Perspective | None
    notes: str = ""
    # For a signal extracted from a tabular source, the exact column header that
    # holds its values (e.g. "strip_temp_C") — this is what lets the Computation
    # Engine later pull the real time-series/values back out, instead of the
    # graph being pure metadata with nothing to actually train on. Null for
    # signals named in free text (SOP/PDF) where no column exists to point at.
    source_reference: str | None = None


class Entity(BaseModel):
    entity_type: EntityType
    id: str
    name: str
    # Required for the same reason as perspective above: with a default the
    # model may omit the whole attributes object, silently losing perspective
    # and source_reference.
    attributes: EntityAttributes
    source: str
    confidence: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def signal_requires_perspective(self) -> "Entity":
        if self.entity_type == EntityType.SIGNAL and self.attributes.perspective is None:
            raise ValueError(
                f"signal entity '{self.id}' is missing a perspective tag "
                "(mechanical/electrical/process) — every signal must carry one"
            )
        return self


class Relationship(BaseModel):
    relationship_type: RelationshipType
    from_id: str
    to_id: str
    source: str


class ExtractionResult(BaseModel):
    """What one LLM extraction call over one parsed source must return."""

    entities: list[Entity]
    relationships: list[Relationship]
