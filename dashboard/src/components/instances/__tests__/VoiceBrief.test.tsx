/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

import { VoiceBrief } from '@/components/instances/VoiceBrief';

// jsdom has no Web Speech API, so we install a minimal stand-in for
// window.speechSynthesis + SpeechSynthesisUtterance and assert against it.
class FakeUtterance {
  text: string;
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

describe('VoiceBrief', () => {
  let speak: jest.Mock;
  let cancel: jest.Mock;

  beforeEach(() => {
    speak = jest.fn();
    cancel = jest.fn();
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      writable: true,
      value: FakeUtterance,
    });
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      writable: true,
      value: { speak, cancel },
    });
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).speechSynthesis;
    delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance;
  });

  it('renders the listen control when speech synthesis is supported', () => {
    render(<VoiceBrief text="Your brief" />);
    expect(screen.getByTestId('voice-brief-toggle')).toBeInTheDocument();
  });

  it('speaks the brief text on play and cancels on stop', () => {
    render(<VoiceBrief text="Read this brief aloud" />);
    const toggle = screen.getByTestId('voice-brief-toggle');

    fireEvent.click(toggle); // play
    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = speak.mock.calls[0][0] as FakeUtterance;
    expect(utterance.text).toBe('Read this brief aloud');
    expect(utterance.rate).toBe(1);

    fireEvent.click(toggle); // stop
    expect(cancel).toHaveBeenCalled();
  });

  it('cycles playback speed 1× → 1.25× → 1.5× → 1×', () => {
    render(<VoiceBrief text="x" />);
    const speed = screen.getByTestId('voice-brief-speed');
    expect(speed).toHaveTextContent('1×');
    fireEvent.click(speed);
    expect(speed).toHaveTextContent('1.25×');
    fireEvent.click(speed);
    expect(speed).toHaveTextContent('1.5×');
    fireEvent.click(speed);
    expect(speed).toHaveTextContent('1×');
  });

  it('renders nothing when speech synthesis is unavailable', () => {
    delete (window as unknown as Record<string, unknown>).speechSynthesis;
    const { container } = render(<VoiceBrief text="nope" />);
    expect(container).toBeEmptyDOMElement();
  });
});
