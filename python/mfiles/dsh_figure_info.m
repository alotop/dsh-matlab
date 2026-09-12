function payload = dsh_figure_info()
%DSH_FIGURE_INFO Describe every open figure, in creation order, as JSON.
%
% Returning JSON text rather than a struct array keeps the Python side free of
% MATLAB struct-array marshalling rules: the driver only ever calls
% `json.loads` on this.
%
% An empty array is a legitimate answer (no figures are open), not an error.

  figs = flipud(findobj('Type', 'figure'));

  info = struct('number', {}, 'name', {}, 'visible', {});
  for k = 1:numel(figs)
    f = figs(k);
    try
      name = char(f.Name);
    catch
      name = '';
    end
    try
      visible = char(f.Visible);
    catch
      visible = 'unknown';
    end
    info(end + 1) = struct('number', double(f.Number), 'name', name, 'visible', visible);
  end

  payload = jsonencode(info);
end
