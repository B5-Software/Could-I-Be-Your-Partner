// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
// TEST ONLY: synthetic reserves and a fixed 2,000 USDC/WETH price. Not a DEX.
contract Token {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    function decimals() external view returns(uint8) {
        return address(this)==0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?6:18;
    }
    function mint(address to,uint256 value) external {balanceOf[to]+=value;}
    function approve(address spender,uint256 value) external returns(bool) {
        allowance[msg.sender][spender]=value;return true;
    }
    function transfer(address to,uint256 value) external returns(bool) {
        require(balanceOf[msg.sender]>=value,"balance");balanceOf[msg.sender]-=value;balanceOf[to]+=value;return true;
    }
    function transferFrom(address from,address to,uint256 value) external returns(bool) {
        require(allowance[from][msg.sender]>=value,"allowance");
        require(balanceOf[from]>=value,"balance");
        allowance[from][msg.sender]-=value;balanceOf[from]-=value;balanceOf[to]+=value;return true;
    }
}
contract Factory {
    function getPool(address,address,uint24) external pure returns(address) {
        return 0x1111111111111111111111111111111111111111;
    }
}
contract Pool {
    function token0() external pure returns(address) {return 0x4200000000000000000000000000000000000006;}
    function token1() external pure returns(address) {return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;}
    function liquidity() external pure returns(uint128) {return 1000000000000000000;}
    function slot0() external pure returns(uint160,int24,uint16,uint16,uint16,uint8,bool) {
        return (3543191142285914205922034,0,0,1,1,0,true);
    }
}
contract Quoter {
    struct Quote {address tokenIn;address tokenOut;uint256 amountIn;uint24 fee;uint160 limit;}
    function quoteExactInputSingle(Quote calldata p) external pure returns(uint256,uint160,uint32,uint256) {
        require(p.fee==500,"fee");
        uint256 result=p.tokenIn==0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?
            p.amountIn*1000000000000/2000:p.amountIn*2000/1000000000000;
        return (result,3543191142285914205922034,0,100000);
    }
}
contract Router {
    struct Swap {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 minimum;uint160 limit;}
    uint256 public executed;
    function multicall(uint256 deadline,bytes[] calldata calls) external payable returns(bytes[] memory results) {
        require(block.timestamp<=deadline,"deadline");require(calls.length==1,"one swap");
        results=new bytes[](calls.length);
        for(uint i=0;i<calls.length;i++){
            (bool ok,bytes memory result)=address(this).delegatecall(calls[i]);
            require(ok,"swap reverted");results[i]=result;
        }
    }
    function exactInputSingle(Swap calldata p) external payable returns(uint256 result) {
        require(p.fee==500&&p.recipient==msg.sender,"scope");
        result=p.tokenIn==0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?
            p.amountIn*1000000000000/2000:p.amountIn*2000/1000000000000;
        require(result>=p.minimum,"slippage");
        Token(p.tokenIn).transferFrom(msg.sender,address(this),p.amountIn);
        Token(p.tokenOut).transfer(p.recipient,result);executed++;
    }
}
