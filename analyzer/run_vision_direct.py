#!/usr/bin/env python3
"""
Direct Vision Analysis Script
Sends extracted video frames to llama3.2-vision and returns structured Q&A output.
"""

import base64
import json
import urllib.request
import urllib.error
import os

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "llama3.2-vision"

SURVEY_PROMPT = (
    "You are analyzing a screenshot from a survey session recording.\n"
    "Look carefully at this screen capture and identify:\n"
    "1. Any survey question visible on screen\n"
    "2. The answer options available (radio buttons, checkboxes, dropdowns, text fields)\n"
    "3. Which answer option appears to be selected/checked/highlighted/filled\n"
    "Respond ONLY with a valid JSON object in this exact format:\n"
    '{\n'
    '  "pageType": "survey_question or survey_intro or redirect or dashboard or other",\n'
    '  "questionText": "The exact question text visible, or null if none",\n'
    '  "answerType": "radio or checkbox or text or dropdown or none",\n'
    '  "options": ["list of visible answer options"],\n'
    '  "selectedAnswer": "The answer that appears selected/checked, or null if none",\n'
    '  "confidence": "high or medium or low",\n'
    '  "reasoning": "Brief explanation of what you see",\n'
    '  "additionalObservations": "Any other info about the page"\n'
    '}'
)

def analyze_frame(image_path, frame_label):
    print(f"\n{'='*60}")
    print(f"Analyzing frame: {frame_label}")
    if not os.path.exists(image_path):
        print(f"   File not found: {image_path}")
        return {}
    with open(image_path, "rb") as f:
        img_b64 = base64.b64encode(f.read()).decode("utf-8")
    file_size = os.path.getsize(image_path)
    print(f"   Size: {file_size/1024:.1f} KB")
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": SURVEY_PROMPT, "images": [img_b64]}],
        "options": {"temperature": 0.0},
        "stream": False,
        "format": "json"
    }
    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        print(f"   Sending to {MODEL} (may take 30-120s)...")
        with urllib.request.urlopen(req, timeout=180) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            content = res["message"]["content"]
            result = json.loads(content.strip())
            print(f"   Page Type  : {result.get('pageType', 'N/A')}")
            print(f"   Question   : {result.get('questionText', 'None')}")
            print(f"   Options    : {result.get('options', [])}")
            print(f"   Selected   : {result.get('selectedAnswer', 'None detected')}")
            print(f"   Confidence : {result.get('confidence', 'N/A')}")
            print(f"   Reasoning  : {result.get('reasoning', 'N/A')}")
            return result
    except urllib.error.URLError as e:
        print(f"   Ollama error: {e}")
        return {}
    except Exception as e:
        print(f"   Error: {e}")
        return {}

def main():
    frames = [
        ("/tmp/frame_5s.jpg",  "t=5s  - realsays platform"),
        ("/tmp/frame_10s.jpg", "t=10s - gowebsurveys initial"),
        ("/tmp/frame_15s.jpg", "t=15s - during/after survey"),
        ("/tmp/frame_20s.jpg", "t=20s - post callback / offers"),
        ("/tmp/frame_25s.jpg", "t=25s"),
        ("/tmp/frame_30s.jpg", "t=30s"),
        ("/tmp/frame_35s.jpg", "t=35s"),
        ("/tmp/frame_40s.jpg", "t=40s"),
    ]
    print("Market Research Tracker - Direct Vision LLM Analysis")
    print(f"Model   : {MODEL}")
    print(f"Session : a40f61a3-028a-47ab-956c-a1d3926185f8")
    print(f"Video   : 10 chunks (9.4MB), 48s duration")
    results = []
    for path, label in frames:
        result = analyze_frame(path, label)
        if result:
            results.append({"frame": label, **result})
    output_path = "/tmp/vision_analysis_output.json"
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n{'='*60}")
    print(f"VISION ANALYSIS COMPLETE")
    print(f"Frames analyzed : {len(results)}")
    survey_pages = [r for r in results if r.get("pageType") == "survey_question"]
    print(f"Survey Q pages  : {len(survey_pages)}")
    for r in survey_pages:
        print(f"  Frame   : {r['frame']}")
        print(f"  Question: {r.get('questionText')}")
        print(f"  Selected: {r.get('selectedAnswer')}")
        print(f"  Conf.   : {r.get('confidence')}")
    print(f"\nFull output: {output_path}")

if __name__ == "__main__":
    main()
