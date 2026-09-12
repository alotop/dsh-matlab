function r = dsh_evalbase(code)
%DSH_EVALBASE Execute CODE in the base workspace, capturing output and errors.
%
% Evaluation is forced into the base workspace via EVALIN so variables persist
% across calls; a function-local EVAL would discard them as soon as the call
% returned.
%
% EVALIN is deliberately asked for NO output argument, and that is what makes
% the capture match the command window: an assignment echoes `x = 41`, a bare
% expression echoes `ans = 42`, and a statement with no value prints nothing.
% Requesting an output argument instead suppresses all three, which is why no
% caller should try to reconstruct the echo by inspecting the value afterwards.
%
% Returns a struct:
%   out   - captured command-window text
%   err   - error message, empty on success
%   stack - formatted error stack, empty when unavailable

  r = struct('out', '', 'err', '', 'stack', '');

  try
    r.out = evalc('evalin(''base'', code)');
  catch err
    r.err = err.message;
    if ~isempty(err.stack)
      parts = arrayfun(@(s) sprintf('%s (line %d)', s.name, s.line), ...
                       err.stack, 'UniformOutput', false);
      r.stack = strjoin(parts, newline);
    end
  end
end
