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

def run_pipeline(session_id: str, sessions_base_dir: str):
    session_dir = os.path.join(sessions_base_dir, session_id)
    if not os.path.isdir(session_dir):
        print(f"Error: Session directory {session_dir} does not exist.")
        sys.exit(1)
        
    print(f"🚀 Starting Survey Q&A Extraction Pipeline for Session: {session_id}")
    
    # Load session metadata and inputs
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
            
    # Process all visited pages from pages.json
    visited_pages = []
    seen_urls = set()
    for p in pages:
        url = p.get("url")
        if not url or url in seen_urls:
            continue
        # Skip bridge page and local extensions
        if "localhost" in url or "chrome-extension" in url:
            continue
        seen_urls.add(url)
        visited_pages.append(p)
        
    analyzed_pages = []
    video_dir = os.path.join(session_dir, "video")
    has_video = len(glob.glob(os.path.join(video_dir, "chunk_*.webm"))) > 0
    
    for page in visited_pages:
        url = page.get("url")
        snap_file = page.get("snapshotFile") if page.get("type") == "html_snapshot" else None
        
        print(f"\n--- Analyzing Page: {url} (Snapshot: {snap_file or 'None'}) ---")
        
        correlated_questions = []
        html_found = False
        
        if snap_file:
            snap_path = os.path.join(session_dir, "snapshots", snap_file)
            if os.path.exists(snap_path):
                html_found = True
                with open(snap_path, "r", encoding="utf-8") as f:
                    html_content = f.read()
                    
                # Layer 1: HTML Heuristic Parser
                parsed_questions = parse_html_snapshot(html_content)
                print(f"  [Layer 1: HTML] Found {len(parsed_questions)} questions.")
                
                # Layer 2: Event Correlation
                correlated_questions = correlate_events_with_questions(parsed_questions, events, url)
                high_conf_count = sum(1 for q in correlated_questions if q.confidence == "high")
                print(f"  [Layer 2: Event Correlation] Confirmed {high_conf_count}/{len(correlated_questions)} questions with high confidence.")
                
                # Layer 3: Vision Fallback (runs if low confidence options exist and video is recorded)
                page_clicks = [e for e in events if e.get("pageUrl") == url and e.get("type") == "click"]
                has_low_conf = any(q.confidence != "high" for q in correlated_questions)
                
                if has_low_conf and has_video:
                    latest_click_ts = page_clicks[-1].get("timestamp", 0) if page_clicks else start_ts
                    latest_click = page_clicks[-1] if page_clicks else {}
                    click_x = latest_click.get("x")
                    click_y = latest_click.get("y")
                    
                    print("  [Layer 3: Vision Fallback] Triggering local llama3.2-vision fallback...")
                    correlated_questions = run_vision_fallback(
                        correlated_questions, 
                        video_dir, 
                        latest_click_ts, 
                        start_ts,
                        click_x=click_x,
                        click_y=click_y
                    )
        
        # Automatic Vision Form Extractor Fallback:
        # If no snapshot exists, or HTML yields 0 questions, but we have click/input events,
        # run the direct visual form extractor on the video.
        page_events = [e for e in events if e.get("pageUrl") == url]
        page_inputs_clicks = [e for e in page_events if e.get("type") in ("click", "input_change")]
        
        if len(correlated_questions) == 0 and len(page_inputs_clicks) > 0 and has_video:
            latest_event_ts = page_inputs_clicks[-1].get("timestamp", 0)
            if latest_event_ts > 0:
                print("  [Automatic Vision Fallback] 0 HTML questions found but user interacted. Running vision form extractor...")
                vision_questions = run_vision_form_extractor(
                    video_dir,
                    latest_event_ts,
                    start_ts,
                    url
                )
                if vision_questions:
                    print(f"  [Automatic Vision Fallback] Extracted {len(vision_questions)} fields visually.")
                    correlated_questions = vision_questions
                    
        # Retrieve domain and pageTitle from pages.json
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
        
    # Compile summary stats
    total_q = sum(len(p.questions) for p in analyzed_pages)
    answered_q = sum(sum(1 for q in p.questions if q.selectedAnswer) for p in analyzed_pages)
    completion_rate = f"{round((answered_q / total_q) * 100, 1)}%" if total_q > 0 else "0.0%"
    
    analysis = SessionAnalysis(
        sessionId=session_id,
        analyzedAt=datetime.utcnow().isoformat() + "Z",
        pages=analyzed_pages,
        summary={
            "totalQuestions": total_q,
            "answeredQuestions": answered_q,
            "completionRate": completion_rate
        }
    )
    
    # Save session analysis.json file
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
    
    if len(sys.argv) >= 3:
        base_dir = sys.argv[2]
    else:
        # Default relative to root
        base_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend", "sessions")
        
    run_pipeline(sess_id, base_dir)
