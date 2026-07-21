# analyzer/test_vision.py

import sys
import os
import base64

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analyzer.layers.vision_extractor import analyze_frame_with_llm

def test_local_vision():
    # 1x1 black PNG image base64
    tiny_img_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
        "YAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    )
    
    img_path = "test_tiny.png"
    with open(img_path, "wb") as f:
        f.write(base64.b64decode(tiny_img_b64))
        
    print("Testing connection to local Ollama llama3.2-vision model...")
    prompt = (
        "This is a test image. Respond with a JSON object:\n"
        "{\n"
        "  \"test\": \"success\"\n"
        "}"
    )
    
    try:
        result = analyze_frame_with_llm(img_path, prompt)
        if result:
            print("🎉 Local vision extraction test SUCCESS!")
            print(f"Ollama response: {result}")
        else:
            print("❌ Local vision extraction failed. Is Ollama running?")
    finally:
        if os.path.exists(img_path):
            os.remove(img_path)

if __name__ == "__main__":
    test_local_vision()
