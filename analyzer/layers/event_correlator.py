# analyzer/layers/event_correlator.py

from typing import List, Dict, Any
from analyzer.output_schema import QuestionAnswer

def correlate_events_with_questions(
    questions: List[QuestionAnswer], 
    events: List[Dict[str, Any]], 
    page_url: str
) -> List[QuestionAnswer]:
    """
    Correlates interaction events (clicks, input changes) with parsed page questions.
    """
    # 1. Filter events matching the target page URL
    page_events = [e for e in events if e.get('pageUrl') == page_url]
    if not page_events:
        return questions
        
    for q in questions:
        # Group selections found via click correlation
        selections = []
        
        # Track if this question represents a text field we want to correlate
        is_text_question = q.questionType in ["open_text", "textarea"]
        
        for event in page_events:
            ev_type = event.get('type')
            target = event.get('target', {})
            
            if ev_type == 'click':
                clicked_text = (target.get('text') or "").strip()
                clicked_id = target.get('id')
                clicked_classes = target.get('classes') or []
                
                # Check if clicked text matches one of the options
                for opt in q.options:
                    if not opt:
                        continue
                    
                    # Match options (exact or clean substring check)
                    clean_opt = opt.strip()
                    clean_click = clicked_text.strip()
                    
                    if clean_click == clean_opt or (clean_click and clean_click in clean_opt) or (clean_opt and clean_opt in clean_click):
                        # To prevent false positives for duplicate options across different questions
                        # (e.g. multiple rating scales from 1 to 5), check for element class/id descriptors
                        if is_click_relevant_to_question(q, clicked_id, clicked_classes, target):
                            selections.append(opt)
                            
            elif ev_type == 'input_change' and is_text_question:
                tgt_id = target.get('id')
                tgt_name = target.get('name')
                val = target.get('value') or target.get('val')
                
                # If input change element ID or name matches the question's elementId
                if (q.elementId and (tgt_id == q.elementId or tgt_name == q.elementId or (tgt_id and tgt_id in q.elementId))):
                    if val:
                        q.selectedAnswer = str(val)
                        q.confidence = "high"
                        q.source = "event_correlation"
                    
        # Update question selection based on click correlation
        if selections:
            if q.questionType == 'checkboxes':
                # Remove duplicates while preserving click order
                unique_selects = []
                for s in selections:
                    if s not in unique_selects:
                        unique_selects.append(s)
                q.selectedAnswer = ", ".join(unique_selects)
                q.confidence = "high"
                q.source = "event_correlation"
            else:
                # Multiple choice / Dropdown: take the last clicked selection
                q.selectedAnswer = selections[-1]
                q.confidence = "high"
                q.source = "event_correlation"
                
    return questions

def is_click_relevant_to_question(
    q: QuestionAnswer, 
    clicked_id: str, 
    clicked_classes: List[str], 
    target: dict
) -> bool:
    """
    Heuristically checks if a click event target is related to the question.
    Helps resolve ambiguities when multiple questions share identical option texts.
    """
    # If the question's elementId matches the clicked element's ID
    if q.elementId and clicked_id and q.elementId in clicked_id:
        return True
        
    # If the question's elementId matches any of the clicked classes
    if q.elementId and any(q.elementId in c for c in clicked_classes):
        return True
        
    # If there are no identifying IDs, check if any unique parts of the question text
    # or options appear in target metadata (e.g., container classes or siblings)
    return True
