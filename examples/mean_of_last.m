function avg = mean_of_last(x, k)
%MEAN_OF_LAST  Mean of the last K elements of vector X.
%
% The window start is `n - k + 1`, not `n - k`: with x = 1:10 and k = 3 the
% window must be x(8:10), whereas `n - k` returned x(7:10) and averaged four
% elements while still dividing by k.

  n = numel(x);
  startIndex = n - k + 1;
  avg = sum(x(startIndex:n)) / k;
end
