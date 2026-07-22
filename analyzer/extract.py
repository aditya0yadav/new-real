# analyzer/extract.py

import os
import sys
import glob
import json
from datetime import datetime
from typing import List, Dict, Any

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analyzer.output_schema import SessionAnalysis, PageAnalysis, QuestionAnswer
from analyzer.layers.html_parser import parse_html_snapshot
from analyzer.layers.event_correlator import correlate_events_with_questions
from analyzer.layers.vision_extractor import run_vision_fallback, run_vision_form_extractor

IGNORE_BUTTON_TEXTS = {
    "start", "next", "submit", "continue", "agree & continue",
    "立即前往问卷", "reward not earned", "click here", "proceed",
    "confirm", "agree", "ok", "cancel", "close", "back"
}

def extract_questions_from_events(events: List[Dict[str, Any]], url: str) -> List[QuestionAnswer]:
    """
    Event-Heuristic Extractor:
    Reconstructs clean, deduplicated Q&A pairs directly from DOM interaction events.
    """
    page_events = [e for e in events if e.get("pageUrl") == url]
    if not page_events:
        return []

    # Map of question identifier -> QuestionAnswer object
    qa_map: Dict[str, QuestionAnswer] = {}

    for ev in page_events:
        ev_type = ev.get("type")
        target = ev.get("target", {})
        
        # 1. Text input change events
        if ev_type == "input_change":
            tag = target.get("tag")
            input_type = target.get("type", "text")
            name = target.get("name") or target.get("id") or "input_field"
            val = target.get("value") or target.get("val") or "[User Input Submitted]"
            q_heading = target.get("questionHeading")
            
            if input_type in ("text", "number", "email", "tel"):
                clean_name = name.replace("queFld[", "").replace("]", "").replace("_", " ").title()
                q_text = q_heading if q_heading else f"Form Field: {clean_name}"
                q_key = f"input_{name}"
                qa_map[q_key] = QuestionAnswer(
                    questionText=q_text,
                    questionType="open_text",
                    options=[],
                    selectedAnswer=str(val),
                    confidence="high",
                    source="event_heuristics",
                    elementId=name
                )

            elif input_type in ("radio", "checkbox"):
                group = target.get("name") or target.get("id") or "radio_group"
                elem_id = target.get("id") or ""
                opt_label = elem_id.replace("radio_", "").replace("_", " ")
                clean_group = group.replace("queFld[", "").replace("]", "").replace("_", " ").title()
                q_text = q_heading if q_heading else f"Survey Question ({clean_group})"
                q_key = f"group_{group}"

                if q_key in qa_map:
                    if opt_label not in qa_map[q_key].options:
                        qa_map[q_key].options.append(opt_label)
                    qa_map[q_key].selectedAnswer = opt_label
                    if q_heading:
                        qa_map[q_key].questionText = q_heading
                else:
                    qa_map[q_key] = QuestionAnswer(
                        questionText=q_text,
                        questionType="multiple_choice" if input_type == "radio" else "checkboxes",
                        options=[opt_label],
                        selectedAnswer=opt_label,
                        confidence="high",
                        source="event_heuristics",
                        elementId=elem_id
                    )

        # 2. Click events on options
        elif ev_type == "click":
            clicked_text = (target.get("text") or "").strip()
            clicked_id = target.get("id") or ""
            q_heading = target.get("questionHeading")

            # Skip navigation / CTA buttons
            if clicked_text.lower() in IGNORE_BUTTON_TEXTS or not clicked_text:
                continue
                
            # Skip pure numbers or raw element IDs if they are click artifacts
            if clicked_text.isdigit() and len(clicked_text) > 4:
                continue

            if clicked_id.startswith("radio_"):
                opt_val = clicked_id.replace("radio_", "").replace("_", " ")
                q_key = f"click_radio_{clicked_id}"
                q_text = q_heading if q_heading else f"Selected Choice ({opt_val})"
                if q_key not in qa_map:
                    qa_map[q_key] = QuestionAnswer(
                        questionText=q_text,
                        questionType="multiple_choice",
                        options=[opt_val],
                        selectedAnswer=opt_val,
                        confidence="high",
                        source="event_heuristics",
                        elementId=clicked_id
                    )
            elif len(clicked_text) < 60:
                q_key = f"click_text_{clicked_text}"
                if q_key not in qa_map:
                    qa_map[q_key] = QuestionAnswer(
                        questionText="Selected Option",
                        questionType="multiple_choice",
                        options=[clicked_text],
                        selectedAnswer=clicked_text,
                        confidence="high",
                        source="event_heuristics",
                        elementId=clicked_id
                    )

    # Post-process & consolidate duplicate entries
    results: List[QuestionAnswer] = []
    seen_texts = set()

    for q in qa_map.values():
        dedup_key = f"{q.questionText}:{q.selectedAnswer}"
        if dedup_key not in seen_texts:
            seen_texts.add(dedup_key)
            results.append(q)

    return results


def run_pipeline(session_id: str, sessions_base_dir: str):
    session_dir = os.path.join(sessions_base_dir, session_id)
    if not os.path.isdir(session_dir):
        print(f"Error: Session directory {session_dir} does not exist.")
        sys.exit(1)
        
    print(f"🚀 Starting Survey Q&A Extraction Pipeline for Session: {session_id}")
    
    session_meta = load_json_file(os.path.join(session_dir, "session.json")) or {}
    pages = load_json_file(os.path.join(session_dir, "pages.json")) or []
    events = load_json_file(os.path.join(session_dir, "events.json")) or []
    
    session_start_time = session_meta.get("startTime")
    start_ts = 0.0
    if session_start_time:
        try:
            dt_str = session_start_time.replace("Z", "+00:00")
            dt = datetime.fromisoformat(dt_str)
            start_ts = dt.timestamp() * 1000.0
        except Exception:
            start_ts = float(session_meta.get("startTime", 0.0))
            
    snapshot_map = {}
    for p in pages:
        if p.get("type") == "html_snapshot" and p.get("snapshotFile"):
            snapshot_map[p.get("url")] = p.get("snapshotFile")

    visited_pages = []
    seen_urls = set()
    for p in pages:
        url = p.get("url")
        if not url or url in seen_urls:
            continue
        if "localhost" in url or "chrome-extension" in url:
            continue
        seen_urls.add(url)
        visited_pages.append(p)
        
    analyzed_pages = []
    video_dir = os.path.join(session_dir, "video")
    has_video = len(glob.glob(os.path.join(video_dir, "chunk_*.webm"))) > 0
    
    for page in visited_pages:
        url = page.get("url")
        snap_file = snapshot_map.get(url) or (page.get("snapshotFile") if page.get("type") == "html_snapshot" else None)
        
        print(f"\n--- Analyzing Page: {url} (Snapshot: {snap_file or 'None'}) ---")
        
        correlated_questions = []
        
        if snap_file:
            snap_path = os.path.join(session_dir, "snapshots", snap_file)
            if os.path.exists(snap_path):
                with open(snap_path, "r", encoding="utf-8") as f:
                    html_content = f.read()
                    
                parsed_questions = parse_html_snapshot(html_content)
                correlated_questions = correlate_events_with_questions(parsed_questions, events, url)

        # Fallback to DOM Event Extractor if HTML yielded 0 questions
        if len(correlated_questions) == 0:
            event_questions = extract_questions_from_events(events, url)
            if event_questions:
                print(f"  [Event-Heuristic Extractor] Extracted {len(event_questions)} questions directly from DOM interaction events.")
                correlated_questions = event_questions

        domain = ""
        page_title = None
        for p in pages:
            if p.get("url") == url:
                domain = p.get("domain", "")
                page_title = p.get("title")
                if domain:
                    break
        if not domain:
            from urllib.parse import urlparse
            try:
                domain = urlparse(url).netloc
            except:
                pass
                
        analyzed_pages.append(PageAnalysis(
            url=url,
            domain=domain,
            pageTitle=page_title,
            snapshotFile=snap_file,
            questions=correlated_questions
        ))
        
    total_q = sum(len(p.questions) for p in analyzed_pages)
    answered_q = sum(sum(1 for q in p.questions if q.selectedAnswer) for p in analyzed_pages)
    completion_rate = f"{round((answered_q / total_q) * 100, 1)}%" if total_q > 0 else "0.0%"
    
    analysis = SessionAnalysis(
        sessionId=session_id,
        analyzedAt=datetime.now().isoformat() + "Z",
        pages=analyzed_pages,
        summary={
            "totalQuestions": total_q,
            "answeredQuestions": answered_q,
            "completionRate": completion_rate
        }
    )
    
    output_path = os.path.join(session_dir, "analysis.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(analysis.to_dict(), f, indent=2)
        
    print(f"\n🏁 Pipeline Complete! Saved analysis details to {output_path}")
    print(f"Total Questions   : {total_q}")
    print(f"Answered Questions: {answered_q} ({completion_rate})")

def load_json_file(file_path: str) -> Any:
    if not os.path.exists(file_path):
        return None
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading {file_path}: {e}")
        return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 extract.py <sessionId> [sessions_base_dir]")
        sys.exit(1)
        
    sess_id = sys.argv[1]
    base_dir = sys.argv[2] if len(sys.argv) >= 3 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend", "sessions")
    run_pipeline(sess_id, base_dir)
