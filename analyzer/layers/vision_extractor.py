# analyzer/layers/vision_extractor.py

import os
import glob
import subprocess
import base64
import json
import urllib.request
import urllib.error
from typing import List, Dict, Any, Optional
from analyzer.output_schema import QuestionAnswer

try:
    from PIL import Image, ImageDraw
    has_pillow = True
except ImportError:
    has_pillow = False

def extract_frame_at_timestamp(video_dir: str, offset_seconds: float, output_path: str) -> bool:
    """
    Extracts a frame from the video chunks at a given offset in seconds using ffmpeg.
    """
    chunks = sorted(glob.glob(os.path.join(video_dir, "chunk_*.webm")))
    if not chunks:
        return False
        
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    except (subprocess.SubprocessError, FileNotFoundError):
        print("⚠️ ffmpeg is not installed or not in PATH. Skipping video frame extraction.")
        return False
        
    # Since streaming MediaRecorder chunks don't have separate EBML headers,
    # we must binary concatenate them first to allow ffmpeg to read past chunk_0000.
    temp_concat_file = os.path.join(video_dir, "temp_concat_merged.webm")
    try:
        with open(temp_concat_file, "wb") as outfile:
            for chunk in chunks:
                with open(chunk, "rb") as infile:
                    outfile.write(infile.read())
                    
        # ffmpeg command to extract frame at dynamic offset
        cmd = [
            "ffmpeg",
            "-y",
            "-ss", str(offset_seconds),
            "-i", temp_concat_file,
            "-vframes", "1",
            "-q:v", "2",
            output_path
        ]
        
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return result.returncode == 0
    except Exception as e:
        print(f"Error extracting frame: {e}")
        return False
    finally:
        if os.path.exists(temp_concat_file):
            try:
                os.remove(temp_concat_file)
            except _:
                pass

def add_click_overlay(image_path: str, x: int, y: int):
    """
    Draws a visual red dot on the screenshot at click coordinates (x, y) to guide the LLM.
    """
    if not has_pillow:
        return
        
    try:
        with Image.open(image_path) as img:
            draw = ImageDraw.Draw(img)
            # Draw a translucent red circle
            radius = 12
            draw.ellipse(
                [x - radius, y - radius, x + radius, y + radius], 
                fill=(239, 68, 68, 127), 
                outline=(220, 38, 38, 255), 
                width=2
            )
            img.save(image_path)
    except Exception as e:
        print(f"Failed to draw click overlay: {e}")

def analyze_frame_with_llm(image_path: str, prompt: str) -> Optional[dict]:
    """
    Tries local Ollama llama3.2-vision model first, then falls back to cloud APIs.
    """
    try:
        with open(image_path, "rb") as image_file:
            img_data = base64.b64encode(image_file.read()).decode('utf-8')
    except Exception as e:
        print(f"Failed to read image file: {e}")
        return None
        
    # 1. Try local Ollama server
    ollama_res = _query_ollama(img_data, prompt)
    if ollama_res:
        return ollama_res
        
    # 2. Fallback to cloud models if key is present
    gemini_key = os.environ.get("GEMINI_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")
    
    if gemini_key:
        print("Falling back to Gemini API...")
        return _query_gemini(img_data, prompt, gemini_key)
    elif openai_key:
        print("Falling back to OpenAI API...")
        return _query_openai(img_data, prompt, openai_key)
        
    return None

def _query_ollama(img_base64: str, prompt: str) -> Optional[dict]:
    url = "http://localhost:11434/api/generate"
    
    payload = {
        "model": "llama3.2-vision",
        "prompt": prompt,
        "images": [img_base64],
        "options": {
            "temperature": 0.0
        },
        "stream": False,
        "format": "json"
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        # Increase timeout to 5 mins to ensure slow vision models on CPU/M1 complete successfully
        with urllib.request.urlopen(req, timeout=300) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            response_content = res_data.get('response', '')
            return json.loads(response_content.strip())
    except urllib.error.URLError as e:
        print(f"Ollama server not reachable: {e.reason}")
        return None
    except Exception as e:
        print(f"Ollama local inference failed: {e}")
        return None

def _query_gemini(img_base64: str, prompt: str, api_key: str) -> Optional[dict]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {"inlineData": {"mimeType": "image/jpeg", "data": img_base64}}
                ]
            }
        ],
        "generationConfig": {"responseMimeType": "application/json"}
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            return json.loads(res_data['candidates'][0]['content']['parts'][0]['text'].strip())
    except Exception as e:
        print(f"Gemini API failed: {e}")
        return None

def _query_openai(img_base64: str, prompt: str, api_key: str) -> Optional[dict]:
    url = "https://api.openai.com/v1/chat/completions"
    payload = {
        "model": "gpt-4o",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_base64}"}}
                ]
            }
        ],
        "response_format": {"type": "json_object"}
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}, method="POST")
    try:
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            return json.loads(res_data['choices'][0]['message']['content'].strip())
    except Exception as e:
        print(f"OpenAI API failed: {e}")
        return None

def run_vision_fallback(
    questions: List[QuestionAnswer], 
    video_dir: str, 
    click_timestamp: float, 
    session_start_time: float,
    click_x: Optional[int] = None,
    click_y: Optional[int] = None
) -> List[QuestionAnswer]:
    """
    Triggers local or remote Vision LLM processing to confirm selected answer details.
    """
    low_conf_questions = [q for q in questions if q.confidence != "high"]
    if not low_conf_questions:
        return questions
        
    offset_seconds = (click_timestamp - session_start_time) / 1000.0
    if offset_seconds < 0:
        offset_seconds = 0
        
    temp_frame = os.path.join(video_dir, f"temp_frame_{int(click_timestamp)}.jpg")
    
    if not extract_frame_at_timestamp(video_dir, offset_seconds, temp_frame):
        return questions
        
    # Draw red dot visual overlay if coordinates are logged
    if click_x is not None and click_y is not None:
        add_click_overlay(temp_frame, click_x, click_y)
        
    try:
        prompt = (
            "Analyze this screenshot of a survey question screen.\n"
            "Identify the question visible and the exact answer option chosen/filled by the user.\n"
            "If a red circle is visible, it points to where the user clicked.\n"
            "Respond ONLY with a JSON object matching this schema:\n"
            "{\n"
            "  \"questionText\": \"The wording of the question\",\n"
            "  \"selectedAnswer\": \"The option that is visually checked, selected, or entered\",\n"
            "  \"confidence\": \"high\" or \"medium\" or \"low\"\n"
            "}"
        )
        
        result = analyze_frame_with_llm(temp_frame, prompt)
        if result:
            q_text = result.get('questionText', '').lower()
            sel_ans = result.get('selectedAnswer')
            
            for q in questions:
                if q_text and (q_text in q.questionText.lower() or q.questionText.lower() in q_text):
                    if sel_ans:
                        q.selectedAnswer = sel_ans
                        q.confidence = result.get('confidence', 'medium')
                        q.source = "vision"
                        q.reasoning = "Visual verification using local llama3.2-vision."
    finally:
        if os.path.exists(temp_frame):
            os.remove(temp_frame)
            
    return questions

def run_vision_form_extractor(
    video_dir: str, 
    click_timestamp: float, 
    session_start_time: float,
    url: str
) -> List[QuestionAnswer]:
    """
    Called when HTML parsing failed or returned 0 questions.
    Extracts all fields visually from a frame.
    """
    offset_seconds = (click_timestamp - session_start_time) / 1000.0
    if offset_seconds < 0:
        offset_seconds = 0
        
    temp_frame = os.path.join(video_dir, f"temp_frame_form_{int(click_timestamp)}.jpg")
    
    if not extract_frame_at_timestamp(video_dir, offset_seconds, temp_frame):
        return []
        
    try:
        prompt = (
            "Analyze this screenshot of a registration or survey form.\n"
            "Identify all fields, input boxes, dropdowns, and text fields visible on screen.\n"
            "For each field, extract: the label of the field, the value/text entered in it, and options if visible.\n"
            "Respond ONLY with a JSON object in this exact format:\n"
            "{\n"
            "  \"fields\": [\n"
            "    {\n"
            "      \"questionText\": \"The field label\",\n"
            "      \"questionType\": \"text or dropdown or radio or checkbox\",\n"
            "      \"options\": [\"list of visible options if it is a dropdown/radio\"],\n"
            "      \"selectedAnswer\": \"The text or option entered/checked, or null if none\",\n"
            "      \"confidence\": \"high or medium or low\",\n"
            "      \"reasoning\": \"Brief explanation of what is visually entered\"\n"
            "    }\n"
            "  ]\n"
            "}"
        )
        
        result_dict = analyze_frame_with_llm(temp_frame, prompt)
        questions = []
        data = None
        if isinstance(result_dict, dict):
            if "fields" in result_dict:
                data = result_dict["fields"]
            else:
                for val in result_dict.values():
                    if isinstance(val, list):
                        data = val
                        break
        elif isinstance(result_dict, list):
            data = result_dict
                    
        if data:
            for item in data:
                q_text = item.get('questionText')
                if q_text:
                    questions.append(QuestionAnswer(
                        questionText=q_text,
                        questionType=item.get('questionType', 'text'),
                        options=item.get('options', []),
                        selectedAnswer=item.get('selectedAnswer') or '',
                        confidence=item.get('confidence', 'medium'),
                        source="vision",
                        elementId=None,
                        reasoning=item.get('reasoning') or "Visually extracted from video frame."
                    ))
        return questions
    finally:
        if os.path.exists(temp_frame):
            try:
                os.remove(temp_frame)
            except _:
                pass

