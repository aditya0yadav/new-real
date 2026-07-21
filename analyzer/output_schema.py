# analyzer/output_schema.py

from dataclasses import dataclass, asdict, field
from typing import List, Optional

@dataclass
class QuestionAnswer:
    questionText: str
    questionType: str  # multiple_choice, checkboxes, dropdown, open_text, matrix, ranking, etc.
    options: List[str] = field(default_factory=list)
    selectedAnswer: Optional[str] = None
    confidence: str = "low"  # high, medium, low
    source: str = "unknown"  # html, event_correlation, vision, consensus
    elementId: Optional[str] = None
    reasoning: Optional[str] = None

@dataclass
class PageAnalysis:
    url: str
    domain: str = ""
    pageTitle: Optional[str] = None
    snapshotFile: Optional[str] = None
    questions: List[QuestionAnswer] = field(default_factory=list)

@dataclass
class SessionAnalysis:
    sessionId: str
    analyzedAt: str
    pages: List[PageAnalysis] = field(default_factory=list)
    summary: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)
