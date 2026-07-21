# analyzer/test_parser.py

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analyzer.layers.html_parser import parse_html_snapshot
from analyzer.layers.event_correlator import correlate_events_with_questions

def test_standard_radio_group():
    html = """
    <div>
        <h3>What is your age?</h3>
        <div>
            <input type="radio" id="age1" name="age" value="18-24">
            <label for="age1">18-24</label>
        </div>
        <div>
            <input type="radio" id="age2" name="age" value="25-34" checked>
            <label for="age2">25-34</label>
        </div>
        <div>
            <input type="radio" id="age3" name="age" value="35-44">
            <label for="age3">35-44</label>
        </div>
    </div>
    """
    results = parse_html_snapshot(html)
    assert len(results) == 1
    q = results[0]
    assert "age" in q.questionText.lower()
    assert q.selectedAnswer == "25-34"
    assert q.confidence == "high"
    print("✅ test_standard_radio_group passed!")

def test_standard_checkbox_group():
    html = """
    <div>
        <h3>Which features do you use?</h3>
        <label><input type="checkbox" name="feats" value="F1" checked> Feature 1</label>
        <label><input type="checkbox" name="feats" value="F2"> Feature 2</label>
        <label><input type="checkbox" name="feats" value="F3" checked> Feature 3</label>
    </div>
    """
    results = parse_html_snapshot(html)
    assert len(results) == 1
    q = results[0]
    assert "features" in q.questionText.lower()
    assert "Feature 1" in q.selectedAnswer
    assert "Feature 3" in q.selectedAnswer
    assert q.confidence == "high"
    print("✅ test_standard_checkbox_group passed!")

def test_custom_radio_group():
    html = """
    <div class="question-block">
        <span class="question-title">How satisfied are you?</span>
        <div class="options-container">
            <div role="radio" class="option-item" aria-checked="false">Dissatisfied</div>
            <div role="radio" class="option-item checked" aria-checked="true">Neutral</div>
            <div role="radio" class="option-item" aria-checked="false">Satisfied</div>
        </div>
    </div>
    """
    results = parse_html_snapshot(html)
    assert len(results) == 1
    q = results[0]
    assert "satisfied" in q.questionText.lower()
    assert q.selectedAnswer == "Neutral"
    assert q.confidence == "medium"
    print("✅ test_custom_radio_group passed!")

def test_event_correlation():
    # Setup parsed questions with no checked answers (simulating dynamic styles or missed DOM checked attributes)
    html = """
    <div class="question-block">
        <h3>What is your gender?</h3>
        <div>
            <div role="radio" class="option-item">Male</div>
            <div role="radio" class="option-item">Female</div>
            <div role="radio" class="option-item">Prefer not to say</div>
        </div>
    </div>
    """
    questions = parse_html_snapshot(html)
    assert len(questions) == 1
    assert questions[0].selectedAnswer is None
    
    # Event logs matching pageUrl
    events = [
        {
            "type": "click",
            "pageUrl": "http://survey.example.com",
            "target": {
                "tag": "div",
                "classes": ["option-item"],
                "text": "Female"
            }
        }
    ]
    
    correlated = correlate_events_with_questions(questions, events, "http://survey.example.com")
    assert len(correlated) == 1
    assert correlated[0].selectedAnswer == "Female"
    assert correlated[0].confidence == "high"
    assert correlated[0].source == "event_correlation"
    print("✅ test_event_correlation passed!")

if __name__ == "__main__":
    test_standard_radio_group()
    test_standard_checkbox_group()
    test_custom_radio_group()
    test_event_correlation()
    print("🎉 All Layer 1 & 2 test cases passed successfully!")
