//+------------------------------------------------------------------+
//|                                                  _DiagProbe.mq5   |
//|                                   mql5-transpiler honesty probe   |
//|                                                                  |
//|  NOT a real EA. A deliberately-broken fixture for the diagnostics |
//|  tests: it exercises each of the three fatal compile-time         |
//|  findings exactly once, so the honesty layer can be asserted.     |
//|                                                                  |
//|    1. iCustom(...)       — a RECOGNISED builtin that is NOT        |
//|                            implemented in the runtime (custom-     |
//|                            indicator transpilation is out of PoC   |
//|                            scope) → MQL_UNIMPLEMENTED_BUILTIN      |
//|    2. ThisIsNotAFunc(...) — a call to an undefined function       |
//|                            → MQL_UNKNOWN_CALL                     |
//|    3. undefinedVariable   — a reference to an undefined variable   |
//|                            → MQL_UNRESOLVED_NAME                  |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler honesty probe"
#property version   "1.00"

int OnInit()
  {
   // (1) iCustom is in the intrinsic table but the runtime has no real impl
   //     (custom-indicator transpilation is out of PoC scope).
   int customHandle = iCustom(_Symbol, _Period, "MyIndicator", 14);

   // (2) a free call to a function that is neither a user fn nor a builtin.
   ThisIsNotAFunc(customHandle);

   // (3) a reference to a name that resolves to nothing.
   int x = undefinedVariable + 1;

   return(INIT_SUCCEEDED);
  }
