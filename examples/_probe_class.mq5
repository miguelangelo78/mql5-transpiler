//+------------------------------------------------------------------+
//|                                                  _probe_class.mq5 |
//|                                    mql5-transpiler feature probe   |
//|                                                                  |
//|  Probe for USER CLASSES WITH METHODS + single inheritance. NOT a  |
//|  real trading EA — it exercises the OOP frontend surface so the   |
//|  integrator can confirm it transpiles to ZERO error diagnostics   |
//|  and runs end-to-end (the class state round-trips through OnInit). |
//+------------------------------------------------------------------+
#property copyright "mql5-transpiler feature probe"
#property version   "1.00"

//--- A base class with a field + methods.
class Accumulator
  {
   int               total;
public:
                     Accumulator() { total = 0; }   // explicit constructor
   void              add(int n)     { total = total + n; }
   int               value()        { return total; }
  };

//--- Single inheritance: Derived adds a scaled add on top of the base.
class ScaledAccumulator : public Accumulator
  {
   int               factor;
public:
   void              setFactor(int f) { factor = f; }
   void              addScaled(int n) { add(n * factor); }   // calls inherited add()
  };

//+------------------------------------------------------------------+
int OnInit()
  {
   ScaledAccumulator acc;
   acc.setFactor(3);
   acc.add(5);          // total = 5
   acc.addScaled(4);    // total = 5 + 4*3 = 17
   Print("Accumulator total = ", acc.value());
   return(INIT_SUCCEEDED);
  }
//+------------------------------------------------------------------+
void OnTick()
  {
  }
//+------------------------------------------------------------------+
