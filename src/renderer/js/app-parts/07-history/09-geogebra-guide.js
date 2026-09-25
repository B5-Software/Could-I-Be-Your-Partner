  const GEOGEBRA_GUIDE = {
    overview: 'GeoGebra 命令按需目录。严格遵循 GGB 语法：命令区分大小写，参数用方括号 []，列表用花括号 {}。求根返回点标签（如 Roots[f] 得 A,B,C），提取值用 x(A)/y(A)。修改样式用 Set* 系列命令。',
    basics: { desc: '函数、曲线与基础对象', commands: ['f(x)=x^2-1', 'g: y=2x+1', 'A=(1,2)', 'a=Slider[0,5,1]', 'Curve[cos(t),sin(t),t,0,2π]', 'x^2+y^2=9（隐式曲线）', 'r=2+cos(θ)（极坐标）', 'Sequence[n^2,n,1,10]'] },
    algebra: { desc: '方程与代数', commands: ['Solve[x^2-1=0]', 'NSolve[x^3=2]', 'Roots[f]', 'Factor[x^2-1]', 'Expand[(x+1)^3]', 'Simplify[(x^2-1)/(x-1)]', 'Substitute[x^2+y^2,{x=1,y=2}]', 'PrimeFactors[360]', 'GCD[12,18]', 'LCM[4,6]'] },
    calculus: { desc: '微积分', commands: ['Derivative[f]', 'Derivative[f,2]', 'Integral[f]', 'Integral[f,0,1]', 'Limit[f,0]', 'TaylorPolynomial[f,0,4]', 'Extremum[f]', 'InflectionPoint[f]', 'Tangent[1,f]', 'Asymptote[f]', 'Sum[n,n,1,100]', 'Product[k,k,1,5]'] },
    geometry: { desc: '几何构造', commands: ['Point[{2,3}]', 'Segment[A,B]', 'Line[A,B]', 'Ray[A,B]', 'Circle[A,2]', 'Circle[A,B,C]', 'Polygon[A,B,C]', 'Intersect[f,g]', 'Midpoint[A,B]', 'PerpendicularLine[A,g]', 'ParallelLine[A,g]', 'Angle[A,B,C]', 'Distance[A,B]', 'PerpendicularBisector[A,B]', 'Locus[Q,P]'] },
    threed: { desc: '3D 图形', commands: ['Plane[A,B,C]', 'Cube[A,B]', 'Tetrahedron[A,B,C,D]', 'Pyramid[poly,H]', 'Surface[u,v,u v]', 'SurfaceOfRevolution[f,xAxis]', 'IntersectPath[a,b]', 'Volume[cube]', 'Sphere[A,2]', 'Cylinder[circle,H]'] },
    cas: { desc: '符号计算（经 geogebraEvalCAS，注意 CAS 与代数视图对象名不同）', commands: ['Solve[x^2-1=0,x]', 'Expand[(x+1)^3]', 'Factor[x^2-1]', 'Substitute[f,x=2]', 'TaylorSeries[sin(x),x,0,4]', 'Integral[x^2,x]', 'Derivative[x^3,x]', 'NSolve[x^3=2,x]'] },
    spreadsheet: { desc: '表格（引用 A1 单元格、批量填充与回归）', commands: ['A1=3', 'FillCells[A1:A10,Sequence[n,n,1,10]]', 'CellRange[A1,B2]', 'FitPoly[A1:A10,2]', 'FitLine[A1:A10]', 'FitExp[A1:A10]', 'Sum[A1:A10]', 'Mean[A1:A10]'] },
    statistics: { desc: '统计与概率', commands: ['Mean[{1,2,3,4,5}]', 'Median[{1,2,3,4,5}]', 'Variance[{1,2,3,4,5}]', 'SD[{1,2,3,4,5}]', 'Histogram[{1,2,2,3,3,3}]', 'BoxPlot[0,1,{1,2,3,4,5}]', 'Normal[0,1,1.96]', 'Binomial[10,0.5,3,false]', 'RandomBetween[1,6]', 'Sample[{1,2,3,4,5},2]'] },
    transform: { desc: '几何变换', commands: ['Reflect[obj,line]', 'Rotate[obj,90°,A]', 'Translate[obj,{2,1}]', 'Dilate[obj,2,A]', 'Stretch[obj,line,2]', 'Shear[obj,line,k]', 'Homothety[A,2,B]', 'MatrixTransform[{{0,1},{1,0}},obj]'] },
    style: { desc: '样式与显示（对象修改，返回无新对象）', commands: ['SetColor[A,255,0,0]', 'SetLineThickness[f,5]', 'SetLineStyle[f,2]', 'SetPointStyle[A,0]', 'SetCaption[A,"P"]', 'SetVisibleInView[f,1,true]', 'SetLayer[A,3]', 'ShowLabel[A,true]', 'ShowAxes[true]', 'ShowGrid[false]', 'SetPerspective["G"]'] },
    scripting: { desc: '脚本与动态（按钮/滑动条交互）', commands: ['Execute[{"SetValue[a,a+1]"}]', 'SetValue[a,2]', 'If[x>0,1,-1]', 'CopyFreeObject[f]', 'SetCoords[A,1,2]', 'StartAnimation[a]', 'SetActiveView[1]', 'Rename[A,"P"]'] }
  };

  window.getGeoGebraGuide = function(category) {
    const cats = Object.keys(GEOGEBRA_GUIDE).filter(k => k !== 'overview');
    if (!category) {
      return { ok: true, categories: cats, overview: GEOGEBRA_GUIDE.overview };
    }
    const key = String(category).toLowerCase();
    const entry = GEOGEBRA_GUIDE[key];
    if (!entry) {
      return { ok: false, error: `未知分类: ${category}`, categories: cats };
    }
    return { ok: true, category: key, desc: entry.desc, commands: entry.commands };
  };

  if (btnCloseGgb) {
    btnCloseGgb.addEventListener('click', () => {
      ggbPanel.classList.add('hidden');
      document.body.classList.remove('geogebra-open');
    });
  }
