function payload = dsh_figure_save(dirPath, which)
%DSH_FIGURE_SAVE Export figures to PNG files and report where each landed, as JSON.
%
% WHICH selects the figures: 0 exports every open figure, a positive number
% exports just that figure. Each becomes figure-<N>.png under DIRPATH.
%
% One figure failing to export (an unsupported renderer, a zero-size canvas)
% must not lose the others, so failures are reported per figure in the `error`
% field rather than raised; the caller sees which ones worked.
%
% JSON text rather than a struct array, so the Python side needs no
% struct-array marshalling -- see dsh_figure_info for the same reasoning.

  if ~exist(dirPath, 'dir')
    mkdir(dirPath);
  end

  if which == 0
    figs = flipud(findobj('Type', 'figure'));
  else
    figs = findobj('Type', 'figure', 'Number', which);
  end

  results = struct('number', {}, 'path', {}, 'error', {});
  for k = 1:numel(figs)
    f = figs(k);
    file = fullfile(dirPath, sprintf('figure-%d.png', f.Number));
    try
      exportgraphics(f, file, 'Resolution', 150);
      results(end + 1) = struct('number', double(f.Number), 'path', file, 'error', '');
    catch err
      results(end + 1) = struct('number', double(f.Number), 'path', '', 'error', err.message);
    end
  end

  payload = jsonencode(results);
end
