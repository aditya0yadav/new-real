# analyzer/layers/html_parser.py

import os
import copy
from bs4 import BeautifulSoup
from typing import List, Dict, Any
from analyzer.output_schema import QuestionAnswer

def parse_html_snapshot(html_content: str) -> List[QuestionAnswer]:
    """
    Parses an HTML snapshot and returns a list of detected questions and answers.
    Uses BeautifulSoup with the built-in html.parser.
    """
    soup = BeautifulSoup(html_content, 'html.parser')
    
    # 1. Strip scripts, styles, metadata, and decorative elements to clean layout
    for tag in soup(['script', 'style', 'noscript', 'meta', 'link', 'iframe', 'svg']):
        tag.decompose()
        
    qa_list = []
    
    # 2. Extract standard input questions
    qa_list.extend(extract_standard_inputs(soup))
    
    # 3. Extract custom-styled components (ARIA roles or custom option classes)
    qa_list.extend(extract_custom_inputs(soup))
    
    # De-duplicate any overlap
    return deduplicate_questions(qa_list)

def get_clean_question_text(parent, elements_to_exclude=None) -> str:
    """
    Extracts the text of a question container while stripping out the text
    of the choices, labels, and input fields to prevent text collision.
    """
    if not parent:
        return ""
        
    # Create a copy so we do not mutate the main document tree
    cloned = copy.copy(parent)
    
    # Decompose inputs, labels, selects, and textareas
    for tag in cloned.find_all(['input', 'label', 'select', 'textarea', 'option', 'button']):
        tag.decompose()
        
    # Decompose elements in the custom exclude list if provided
    if elements_to_exclude:
        for el in elements_to_exclude:
            # Match by class name or tag name if cloned has them
            el_class = el.get('class')
            if el_class:
                for c in el_class:
                    for found in cloned.find_all(class_=c):
                        found.decompose()
                        
    # Try finding typical header/title tags first
    for header_tag in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend']:
        header = cloned.find(header_tag)
        if header and header.text.strip():
            return header.text.strip()
            
    # Look for spans/divs with question/title/header class names
    q_span = cloned.find(class_=lambda c: c and any(k in c.lower() for k in ['question', 'q-text', 'title', 'header']))
    if q_span and q_span.text.strip():
        return q_span.text.strip()
        
    # Fallback: return the remaining stripped text of the container
    lines = [line.strip() for line in cloned.text.split('\n') if line.strip()]
    if lines:
        return " ".join(lines)
        
    return ""

def find_label_for_input(inp: Any) -> str:
    """Finds the text label for a checkbox or radio button."""
    inp_id = inp.get('id')
    if inp_id:
        # Match by for attribute
        label = inp.find_parent().find('label', attrs={'for': inp_id}) or \
                inp.find_parent().find_parent().find('label', attrs={'for': inp_id})
        if label and label.text.strip():
            return label.text.strip()
            
    # If the input is nested inside a label element
    parent_label = inp.find_parent('label')
    if parent_label and parent_label.text.strip():
        return parent_label.text.strip()
        
    # Look at immediate siblings
    for s in inp.next_siblings:
        text = s.text.strip() if hasattr(s, 'text') else str(s).strip()
        if text:
            return text
            
    for s in inp.previous_siblings:
        text = s.text.strip() if hasattr(s, 'text') else str(s).strip()
        if text:
            return text
            
    return ""

def extract_standard_inputs(soup: BeautifulSoup) -> List[QuestionAnswer]:
    results = []
    
    # 1. Process free text fields (input type=text, textarea)
    text_inputs = soup.find_all(['input', 'textarea'])
    for inp in text_inputs:
        inp_type = inp.get('type', 'text').lower()
        if inp_type in ['radio', 'checkbox', 'hidden', 'submit', 'button', 'image', 'file']:
            continue
            
        value = inp.get('value') or (inp.string or "").strip()
        if not value:
            # Skips unfilled text fields to keep output clean unless needed
            continue
            
        # Climb up to find question context
        parent_container = inp.find_parent(class_=lambda c: c and 'question' in c.lower()) or inp.parent.parent
        q_text = get_clean_question_text(parent_container)
        
        if q_text:
            results.append(QuestionAnswer(
                questionText=q_text,
                questionType="open_text",
                options=[],
                selectedAnswer=value,
                confidence="high",
                source="html",
                elementId=inp.get('id') or inp.get('name')
            ))
            
    # 2. Process dropdown selects
    selects = soup.find_all('select')
    for sel in selects:
        options = [opt.text.strip() for opt in sel.find_all('option') if opt.text.strip()]
        selected_opt = sel.find('option', selected=True)
        selected_val = selected_opt.text.strip() if selected_opt else None
        
        if not selected_val:
            # If no option has selected attribute, see if a default selected value exists
            first_opt = sel.find('option')
            if first_opt and not first_opt.get('disabled') and first_opt.text.strip():
                selected_val = first_opt.text.strip()
                
        parent_container = sel.find_parent(class_=lambda c: c and 'question' in c.lower()) or sel.parent.parent
        q_text = get_clean_question_text(parent_container)
        
        if q_text:
            results.append(QuestionAnswer(
                questionText=q_text,
                questionType="dropdown",
                options=options,
                selectedAnswer=selected_val,
                confidence="high" if selected_val else "low",
                source="html",
                elementId=sel.get('id') or sel.get('name')
            ))
            
    # 3. Process checkboxes and radio groups
    grouped_inputs: Dict[str, List[Any]] = {}
    for inp in soup.find_all('input', type=['radio', 'checkbox']):
        group_name = inp.get('name') or inp.get('id')
        if group_name:
            grouped_inputs.setdefault(group_name, []).append(inp)
            
    for name, inputs in grouped_inputs.items():
        if not inputs:
            continue
            
        options = []
        selected_answers = []
        input_type = inputs[0].get('type').lower()
        q_type = "multiple_choice" if input_type == 'radio' else "checkboxes"
        
        for inp in inputs:
            opt_text = find_label_for_input(inp)
            if opt_text:
                options.append(opt_text)
                if inp.has_attr('checked') or inp.get('checked') is not None:
                    selected_answers.append(opt_text)
                    
        # Find common ancestor container for the group
        parent_container = inputs[0].find_parent(class_=lambda c: c and 'question' in c.lower())
        if not parent_container:
            # Fallback: climb up until we find a shared ancestor container that contains all inputs in the group
            parent_container = inputs[0].parent
            while parent_container:
                container_inputs = parent_container.find_all('input')
                if all(inp in container_inputs for inp in inputs):
                    break
                parent_container = parent_container.parent
                
        q_text = get_clean_question_text(parent_container)
        if q_text and options:
            ans = ", ".join(selected_answers) if q_type == "checkboxes" else (selected_answers[0] if selected_answers else None)
            results.append(QuestionAnswer(
                questionText=q_text,
                questionType=q_type,
                options=options,
                selectedAnswer=ans,
                confidence="high" if selected_answers else "low",
                source="html",
                elementId=name
            ))
            
    return results

def extract_custom_inputs(soup: BeautifulSoup) -> List[QuestionAnswer]:
    """
    Parses custom survey controls like div-based radio buttons, sliders, etc.
    """
    results = []
    
    # 1. Custom widgets using role attributes
    custom_items = soup.find_all(attrs={"role": ["radio", "checkbox", "option"]})
    
    # Group custom choice items by parent containers
    containers: Dict[Any, List[Any]] = {}
    for item in custom_items:
        parent = item.find_parent(class_=lambda c: c and ('question' in c or 'container' in c or 'group' in c)) or item.parent
        containers.setdefault(parent, []).append(item)
        
    for container, items in containers.items():
        options = []
        selected_answers = []
        
        first_role = items[0].get('role').lower()
        q_type = "checkboxes" if first_role == "checkbox" else "multiple_choice"
        
        for item in items:
            opt_text = item.text.strip() or item.get('aria-label') or item.get('title') or ""
            if not opt_text:
                continue
                
            options.append(opt_text)
            
            # Detect selection state via ARIA attributes or style classes
            is_checked = (
                item.get('aria-checked') == 'true' or
                item.get('aria-selected') == 'true' or
                any(c in (item.get('class') or []) for c in ['checked', 'selected', 'active', 'is-active', 'is-selected'])
            )
            if is_checked:
                selected_answers.append(opt_text)
                
        q_text = get_clean_question_text(container, elements_to_exclude=items)
        if (not q_text or len(q_text) < 3) and container.parent:
            container = container.parent
            q_text = get_clean_question_text(container, elements_to_exclude=items)
            
        if q_text and options:
            ans = ", ".join(selected_answers) if q_type == "checkboxes" else (selected_answers[0] if selected_answers else None)
            results.append(QuestionAnswer(
                questionText=q_text,
                questionType=q_type,
                options=options,
                selectedAnswer=ans,
                confidence="medium" if selected_answers else "low",
                source="html",
                elementId=container.get('id') or (container.get('class')[0] if container.get('class') else None)
            ))
            
    return results

def deduplicate_questions(questions: List[QuestionAnswer]) -> List[QuestionAnswer]:
    seen: Dict[str, QuestionAnswer] = {}
    for q in questions:
        key = q.questionText.lower().strip()
        if not key:
            continue
        if key in seen:
            existing = seen[key]
            # Prioritize higher confidence extraction
            if q.confidence == "high" and existing.confidence != "high":
                seen[key] = q
            elif q.selectedAnswer and not existing.selectedAnswer:
                seen[key] = q
        else:
            seen[key] = q
            
    return list(seen.values())
